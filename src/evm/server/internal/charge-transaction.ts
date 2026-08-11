import { keccak256, parseTransaction, type Address, type Hex } from 'viem'
import { sendRawTransaction, waitForTransactionReceipt } from 'viem/actions'

import { VerificationFailedError } from '../../../Errors.js'
import type * as z from '../../../zod.js'
import type * as Methods from '../../Methods.js'
import {
  assertTransferCall,
  assertTransferLogs,
  markUsed,
  releaseUsed,
  toReceipt,
} from './charge-shared.js'
import type { Challenge, ChargeStore, Request } from './charge-types.js'

export async function verifyTransaction(parameters: {
  challenge: Pick<Challenge, 'id'>
  client: any
  payload: Extract<
    z.output<typeof Methods.charge.schema.credential.payload>,
    { type: 'transaction' }
  >
  request: Request
  store: ChargeStore
}): Promise<import('../../../Receipt.js').Receipt> {
  const { client, payload, request } = parameters
  const methodDetails = request.methodDetails!
  if (methodDetails.splits)
    throw new VerificationFailedError({ reason: 'Transaction credentials do not support splits.' })
  const serialized = payload.signature as Hex
  const hash = keccak256(serialized)
  const replayKey = `tx:${hash.toLowerCase()}`
  if (!(await markUsed(parameters.store, replayKey)))
    throw new VerificationFailedError({ reason: 'Transaction has already been used.' })

  try {
    const transaction = parseTransaction(serialized) as any
    const data = transaction.data ?? transaction.input
    if (transaction.chainId !== undefined && transaction.chainId !== methodDetails.chainId)
      throw new VerificationFailedError({ reason: 'Transaction chainId does not match challenge.' })
    assertTransferCall({ data, to: transaction.to }, request)

    const reference = await sendRawTransaction(client, { serializedTransaction: serialized })
    const receipt = await waitForTransactionReceipt(client, { hash: reference })
    assertTransferLogs(receipt, {
      currency: request.currency as Address,
      sender: receipt.from,
      transfers: [{ amount: request.amount, recipient: request.recipient as Address }],
    })
    if (reference.toLowerCase() !== hash.toLowerCase())
      await markUsed(parameters.store, `tx:${reference.toLowerCase()}`)
    return toReceipt(receipt, {
      challenge: parameters.challenge,
      chainId: methodDetails.chainId!,
      request,
    })
  } catch (error) {
    await releaseUsed(parameters.store, replayKey)
    throw error
  }
}
