import { type Address, type Hex } from 'viem'
import { call, verifyTypedData, waitForTransactionReceipt, writeContract } from 'viem/actions'

import { VerificationFailedError } from '../../../Errors.js'
import type * as z from '../../../zod.js'
import { eip3009Abi } from '../../internal/abis.js'
import * as Address_internal from '../../internal/address.js'
import * as Charge_internal from '../../internal/charge.js'
import type * as Methods from '../../Methods.js'
import {
  assertBalance,
  assertTransferLogs,
  encodeCallData,
  markUsed,
  releaseUsed,
  resolveAuthorizationDomain,
  splitSignature,
  toReceipt,
} from './charge-shared.js'
import type {
  AuthorizationDomain,
  Challenge,
  ChargeStore,
  GetAccount,
  Request,
} from './charge-types.js'

export async function verifyAuthorization(parameters: {
  authorizationDomain?: AuthorizationDomain | undefined
  challenge: Challenge
  client: any
  credential: {
    payload: Extract<
      z.output<typeof Methods.charge.schema.credential.payload>,
      { type: 'authorization' }
    >
    source?: string | undefined
  }
  getAccount: GetAccount
  request: Request
  store: ChargeStore
}): Promise<import('../../../Receipt.js').Receipt> {
  const { challenge, client, credential, request } = parameters
  const methodDetails = request.methodDetails!
  if (!parameters.authorizationDomain)
    throw new VerificationFailedError({ reason: 'EIP-3009 authorization is not enabled.' })
  if (methodDetails.splits)
    throw new VerificationFailedError({ reason: 'EIP-3009 authorization does not support splits.' })

  const payload = credential.payload
  const expectedHash = Charge_internal.challengeHash(challenge)
  if (!Address_internal.equal(payload.to, request.recipient))
    throw new VerificationFailedError({
      reason: 'Authorization recipient does not match challenge.',
    })
  if (payload.value !== request.amount)
    throw new VerificationFailedError({ reason: 'Authorization amount does not match challenge.' })
  if (payload.nonce.toLowerCase() !== expectedHash.toLowerCase())
    throw new VerificationFailedError({ reason: 'Authorization nonce does not match challenge.' })
  if (BigInt(payload.validBefore) < BigInt(Math.floor(Date.now() / 1000)))
    throw new VerificationFailedError({ reason: 'Authorization has expired.' })

  const source = Address_internal.parseSource(credential.source)
  if (
    source &&
    (!Address_internal.equal(source.address, payload.from) ||
      source.chainId !== methodDetails.chainId)
  )
    throw new VerificationFailedError({ reason: 'Authorization source is invalid.' })

  const replayKey = `authorization:${methodDetails.chainId}:${payload.from.toLowerCase()}:${payload.nonce.toLowerCase()}`
  if (!(await markUsed(parameters.store, replayKey)))
    throw new VerificationFailedError({ reason: 'Authorization credential has already been used.' })

  try {
    const domain = await resolveAuthorizationDomain(parameters.authorizationDomain, {
      chainId: methodDetails.chainId!,
      currency: request.currency as Address,
    })
    const valid = await verifyTypedData(client, {
      address: payload.from as Address,
      domain,
      message: {
        from: payload.from,
        nonce: payload.nonce as Hex,
        to: payload.to,
        validAfter: BigInt(payload.validAfter),
        validBefore: BigInt(payload.validBefore),
        value: BigInt(payload.value),
      },
      primaryType: 'TransferWithAuthorization',
      signature: payload.signature as Hex,
      types: Charge_internal.eip3009Types,
    })
    if (!valid) throw new VerificationFailedError({ reason: 'Authorization signature is invalid.' })

    await assertBalance(client, {
      amount: request.amount,
      currency: request.currency as Address,
      owner: payload.from as Address,
    })

    const account = parameters.getAccount(client, {})
    const [v, r, s] = splitSignature(payload.signature as Hex)
    const request_ = {
      abi: eip3009Abi,
      account,
      address: request.currency as Address,
      args: [
        payload.from as Address,
        payload.to as Address,
        BigInt(payload.value),
        BigInt(payload.validAfter),
        BigInt(payload.validBefore),
        payload.nonce as Hex,
        v,
        r,
        s,
      ],
      functionName: 'transferWithAuthorization',
    } as const
    await call(client, {
      account,
      data: encodeCallData(request_),
      to: request.currency as Address,
    } as never)
    const hash = await writeContract(client, request_ as never)
    const receipt = await waitForTransactionReceipt(client, { hash })
    assertTransferLogs(receipt, {
      currency: request.currency as Address,
      sender: payload.from as Address,
      transfers: [{ amount: request.amount, recipient: request.recipient as Address }],
    })
    return toReceipt(receipt, { challenge, chainId: methodDetails.chainId!, request })
  } catch (error) {
    await releaseUsed(parameters.store, replayKey)
    throw error
  }
}
