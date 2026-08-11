import { type Address, type Hex } from 'viem'
import { getTransaction, getTransactionReceipt } from 'viem/actions'

import { VerificationFailedError } from '../../../Errors.js'
import type * as z from '../../../zod.js'
import type * as Methods from '../../Methods.js'
import { assertTransferCall, assertTransferLogs, markUsed, toReceipt } from './charge-shared.js'
import type { Challenge, ChargeStore, Request } from './charge-types.js'

export async function verifyHash(parameters: {
  challenge: Pick<Challenge, 'id'>
  client: any
  payload: Extract<z.output<typeof Methods.charge.schema.credential.payload>, { type: 'hash' }>
  request: Request
  store: ChargeStore
}): Promise<import('../../../Receipt.js').Receipt> {
  const { client, payload, request } = parameters
  const methodDetails = request.methodDetails!
  if (methodDetails.splits)
    throw new VerificationFailedError({ reason: 'Hash credentials do not support splits.' })
  const hash = payload.hash as Hex
  const receipt = await getTransactionReceipt(client, { hash })
  const transaction = await getTransaction(client, { hash }).catch(() => undefined)
  if (transaction?.to) assertTransferCall({ data: transaction.input, to: transaction.to }, request)
  assertTransferLogs(receipt, {
    currency: request.currency as Address,
    sender: receipt.from,
    transfers: [{ amount: request.amount, recipient: request.recipient as Address }],
  })
  if (!(await markUsed(parameters.store, `hash:${hash.toLowerCase()}`)))
    throw new VerificationFailedError({ reason: 'Transaction hash has already been used.' })
  return toReceipt(receipt, {
    challenge: parameters.challenge,
    chainId: methodDetails.chainId!,
    request,
  })
}
