import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  hexToNumber,
  parseEventLogs,
  slice,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { readContract } from 'viem/actions'

import { VerificationFailedError } from '../../../Errors.js'
import * as Receipt from '../../../Receipt.js'
import * as Address_internal from '../../internal/address.js'
import type * as Charge_internal from '../../internal/charge.js'
import type { AuthorizationDomain, ChargeStore, Request } from './charge-types.js'

export async function assertBalance(
  client: any,
  parameters: { amount: string; currency: Address; owner: Address },
) {
  const balance = await readContract(client, {
    abi: erc20Abi,
    address: parameters.currency,
    args: [parameters.owner],
    functionName: 'balanceOf',
  })
  if (balance < BigInt(parameters.amount))
    throw new VerificationFailedError({ reason: 'Token balance is insufficient.' })
}

export function assertTransferCall(
  call: { data?: Hex | undefined; to?: Address | undefined },
  request: Request,
) {
  if (!call.to || !isAddressEqual(getAddress(call.to), getAddress(request.currency)))
    throw new VerificationFailedError({ reason: 'Transaction token does not match challenge.' })
  if (!call.data) throw new VerificationFailedError({ reason: 'Transaction calldata is missing.' })

  const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data })
  if (decoded.functionName !== 'transfer')
    throw new VerificationFailedError({ reason: 'Transaction is not an ERC-20 transfer.' })
  const [recipient, amount] = decoded.args as [Address, bigint]
  if (!Address_internal.equal(recipient, request.recipient))
    throw new VerificationFailedError({ reason: 'Transaction recipient does not match challenge.' })
  if (amount.toString() !== request.amount)
    throw new VerificationFailedError({ reason: 'Transaction amount does not match challenge.' })
}

export function assertTransferLogs(
  receipt: TransactionReceipt,
  parameters: {
    currency: Address
    sender: Address
    transfers: readonly Charge_internal.Transfer[]
  },
) {
  if (receipt.status !== 'success')
    throw new Error(`Transaction reverted: ${receipt.transactionHash}`)
  const logs = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs,
  })
  const used = new Set<number>()
  for (const transfer of parameters.transfers) {
    const index = logs.findIndex((log, logIndex) => {
      if (used.has(logIndex)) return false
      if (!Address_internal.equal(log.address, parameters.currency)) return false
      if (!Address_internal.equal(log.args.from, parameters.sender)) return false
      if (!Address_internal.equal(log.args.to, transfer.recipient)) return false
      return log.args.value.toString() === transfer.amount
    })
    if (index === -1)
      throw new VerificationFailedError({
        reason: 'Payment verification failed: no matching transfer found.',
      })
    used.add(index)
  }
}

export function splitSignature(signature: Hex): [number, Hex, Hex] {
  const r = slice(signature, 0, 32)
  const s = slice(signature, 32, 64)
  const v = hexToNumber(slice(signature, 64, 65))
  return [v, r, s]
}

export function encodeCallData(request: {
  abi: readonly unknown[]
  args: readonly unknown[]
  functionName: string
}) {
  return encodeFunctionData(request as never)
}

export function toReceipt(
  receipt: TransactionReceipt,
  parameters: {
    challenge?: { id: string } | undefined
    chainId: number
    request: Request
  },
): Receipt.Receipt {
  if (receipt.status !== 'success')
    throw new Error(`Transaction reverted: ${receipt.transactionHash}`)
  return {
    method: 'evm',
    reference: receipt.transactionHash,
    status: 'success',
    timestamp: new Date().toISOString(),
    ...(parameters.challenge && { challengeId: parameters.challenge.id }),
    chainId: parameters.chainId,
    ...(parameters.request.externalId && { externalId: parameters.request.externalId }),
  } as Receipt.Receipt
}

export async function resolveAuthorizationDomain(
  domain: AuthorizationDomain,
  parameters: { chainId: number; currency: Address },
) {
  const resolved = typeof domain === 'function' ? await domain(parameters) : domain
  return {
    ...resolved,
    chainId: resolved.chainId ?? parameters.chainId,
    verifyingContract:
      resolved.verifyingContract ?? Address_internal.normalize(parameters.currency),
  }
}

function getStoreKey(key: string): `mppx:evm:charge:${string}` {
  return `mppx:evm:charge:${key}`
}

export async function markUsed(store: ChargeStore, key: string) {
  return store.update(getStoreKey(key), (current) => {
    if (current !== null) return { op: 'noop', result: false }
    return { op: 'set', value: Date.now(), result: true }
  })
}

export async function releaseUsed(store: ChargeStore, key: string) {
  await store.delete(getStoreKey(key))
}
