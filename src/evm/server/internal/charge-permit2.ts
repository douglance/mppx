import { erc20Abi, type Address, type Hex, type TransactionReceipt } from 'viem'
import {
  call,
  readContract,
  verifyTypedData,
  waitForTransactionReceipt,
  writeContract,
} from 'viem/actions'

import { VerificationFailedError } from '../../../Errors.js'
import * as Account from '../../../viem/Account.js'
import type * as z from '../../../zod.js'
import { permit2Abi } from '../../internal/abis.js'
import * as Address_internal from '../../internal/address.js'
import * as Charge_internal from '../../internal/charge.js'
import type * as Methods from '../../Methods.js'
import {
  assertBalance,
  assertTransferLogs,
  encodeCallData,
  markUsed,
  releaseUsed,
  toReceipt,
} from './charge-shared.js'
import type { Challenge, ChargeStore, GetAccount, Request } from './charge-types.js'

export async function verifyPermit2(parameters: {
  challenge: Challenge
  client: any
  credential: {
    payload: Extract<z.output<typeof Methods.charge.schema.credential.payload>, { type: 'permit2' }>
    source?: string | undefined
  }
  getAccount: GetAccount
  request: Request
  store: ChargeStore
}): Promise<import('../../../Receipt.js').Receipt> {
  const { challenge, client, credential, request } = parameters
  const methodDetails = request.methodDetails!
  const source = Address_internal.parseSource(credential.source)
  if (!source || source.chainId !== methodDetails.chainId)
    throw new VerificationFailedError({ reason: 'Permit2 credential source is invalid.' })

  const serverAccount = parameters.getAccount(client, {})
  if (
    methodDetails.spender &&
    !Address_internal.equal(methodDetails.spender, serverAccount.address)
  )
    throw new VerificationFailedError({ reason: 'Permit2 spender does not match server account.' })
  const expectedHash = Charge_internal.challengeHash(challenge)
  const payload = credential.payload
  if (payload.witness.challengeHash.toLowerCase() !== expectedHash.toLowerCase())
    throw new VerificationFailedError({ reason: 'Permit2 witness does not match challenge.' })

  const transfers = Charge_internal.getTransfers({
    amount: request.amount,
    methodDetails,
    recipient: request.recipient as Address,
  })
  assertPermit2Transfers(payload, { currency: request.currency as Address, transfers })

  const replayKey = `permit2:${methodDetails.chainId}:${source.address.toLowerCase()}:${payload.permit.nonce}`
  if (!(await markUsed(parameters.store, replayKey)))
    throw new VerificationFailedError({ reason: 'Permit2 credential has already been used.' })

  try {
    const permit2Address = Charge_internal.resolvePermit2Address(methodDetails.permit2Address)
    const valid = await verifyPermit2Signature(client, {
      address: source.address,
      payload,
      permit2Address,
      chainId: methodDetails.chainId!,
      challengeHash: expectedHash,
      spender: serverAccount.address,
    })
    if (!valid) throw new VerificationFailedError({ reason: 'Permit2 signature is invalid.' })
    if (BigInt(payload.permit.deadline) < BigInt(Math.floor(Date.now() / 1000)))
      throw new VerificationFailedError({ reason: 'Permit2 deadline has passed.' })

    await assertBalance(client, {
      amount: request.amount,
      currency: request.currency as Address,
      owner: source.address,
    })
    await assertPermit2TokenApproval(client, {
      amount: request.amount,
      currency: request.currency as Address,
      owner: source.address,
      permit2Address,
    })

    const receipt = await submitPermit2(client, {
      account: serverAccount,
      owner: source.address,
      payload,
      permit2Address,
    })
    assertTransferLogs(receipt, {
      currency: request.currency as Address,
      sender: source.address,
      transfers,
    })
    return toReceipt(receipt, { challenge, chainId: methodDetails.chainId!, request })
  } catch (error) {
    await releaseUsed(parameters.store, replayKey)
    throw error
  }
}

function assertPermit2Transfers(
  payload: Extract<z.output<typeof Methods.charge.schema.credential.payload>, { type: 'permit2' }>,
  parameters: { currency: Address; transfers: readonly Charge_internal.Transfer[] },
) {
  if (payload.permit.permitted.length !== payload.transferDetails.length)
    throw new VerificationFailedError({
      reason: 'Permit2 permitted and transferDetails lengths differ.',
    })
  if (payload.transferDetails.length !== parameters.transfers.length)
    throw new VerificationFailedError({
      reason: 'Permit2 transfer count does not match challenge.',
    })

  parameters.transfers.forEach((transfer, index) => {
    const permitted = payload.permit.permitted[index]!
    const details = payload.transferDetails[index]!
    if (!Address_internal.equal(permitted.token, parameters.currency))
      throw new VerificationFailedError({ reason: 'Permit2 token does not match challenge.' })
    if (BigInt(permitted.amount) < BigInt(transfer.amount))
      throw new VerificationFailedError({ reason: 'Permit2 permitted amount is too low.' })
    if (!Address_internal.equal(details.to, transfer.recipient))
      throw new VerificationFailedError({ reason: 'Permit2 recipient does not match challenge.' })
    if (details.requestedAmount !== transfer.amount)
      throw new VerificationFailedError({ reason: 'Permit2 amount does not match challenge.' })
  })
}

async function verifyPermit2Signature(
  client: any,
  parameters: {
    address: Address
    chainId: number
    challengeHash: Hex
    payload: Extract<z.output<typeof Methods.charge.schema.credential.payload>, { type: 'permit2' }>
    permit2Address: Address
    spender: Address
  },
) {
  const { payload } = parameters
  const batch = payload.permit.permitted.length > 1
  const primaryType = batch ? 'PermitBatchWitnessTransferFrom' : 'PermitWitnessTransferFrom'
  const types = {
    TokenPermissions: Charge_internal.permit2WitnessTypes.TokenPermissions,
    PaymentWitness: Charge_internal.permit2WitnessTypes.PaymentWitness,
    [primaryType]: [
      { name: 'permitted', type: batch ? 'TokenPermissions[]' : 'TokenPermissions' },
      { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'witness', type: 'PaymentWitness' },
    ],
  } as const
  return verifyTypedData(client, {
    address: parameters.address,
    domain: {
      chainId: parameters.chainId,
      name: 'Permit2',
      verifyingContract: parameters.permit2Address,
    },
    message: {
      permitted: batch
        ? payload.permit.permitted.map((entry) => ({
            amount: BigInt(entry.amount),
            token: entry.token,
          }))
        : {
            amount: BigInt(payload.permit.permitted[0]!.amount),
            token: payload.permit.permitted[0]!.token,
          },
      spender: parameters.spender,
      nonce: BigInt(payload.permit.nonce),
      deadline: BigInt(payload.permit.deadline),
      witness: { challengeHash: parameters.challengeHash },
    },
    primaryType,
    signature: payload.signature as Hex,
    types,
  } as never)
}

async function assertPermit2TokenApproval(
  client: any,
  parameters: {
    amount: string
    currency: Address
    owner: Address
    permit2Address: Address
  },
) {
  const allowance = await readContract(client, {
    abi: erc20Abi,
    address: parameters.currency,
    args: [parameters.owner, parameters.permit2Address],
    functionName: 'allowance',
  })
  if (allowance < BigInt(parameters.amount))
    throw new VerificationFailedError({ reason: 'Permit2 token approval is insufficient.' })
}

async function submitPermit2(
  client: any,
  parameters: {
    account: Account.Account
    owner: Address
    payload: Extract<z.output<typeof Methods.charge.schema.credential.payload>, { type: 'permit2' }>
    permit2Address: Address
  },
): Promise<TransactionReceipt> {
  const { payload } = parameters
  const batch = payload.permit.permitted.length > 1
  const args = batch
    ? [
        {
          deadline: BigInt(payload.permit.deadline),
          nonce: BigInt(payload.permit.nonce),
          permitted: payload.permit.permitted.map((entry) => ({
            amount: BigInt(entry.amount),
            token: entry.token,
          })),
        },
        payload.transferDetails.map((entry) => ({
          requestedAmount: BigInt(entry.requestedAmount),
          to: entry.to,
        })),
        parameters.owner,
        payload.witness.challengeHash as Hex,
        Charge_internal.witnessTypeString,
        payload.signature as Hex,
      ]
    : [
        {
          deadline: BigInt(payload.permit.deadline),
          nonce: BigInt(payload.permit.nonce),
          permitted: {
            amount: BigInt(payload.permit.permitted[0]!.amount),
            token: payload.permit.permitted[0]!.token,
          },
        },
        {
          requestedAmount: BigInt(payload.transferDetails[0]!.requestedAmount),
          to: payload.transferDetails[0]!.to,
        },
        parameters.owner,
        payload.witness.challengeHash as Hex,
        Charge_internal.witnessTypeString,
        payload.signature as Hex,
      ]
  const functionName = batch ? 'permitBatchWitnessTransferFrom' : 'permitWitnessTransferFrom'
  const request = {
    abi: permit2Abi,
    account: parameters.account,
    address: parameters.permit2Address,
    args,
    functionName,
  } as const
  await call(client, {
    account: parameters.account,
    data: encodeCallData(request),
    to: parameters.permit2Address,
  } as never)
  const hash = await writeContract(client, request as never)
  return waitForTransactionReceipt(client, { hash })
}
