import { KeyAuthorization } from 'ox/tempo'
import { isAddressEqual, type Address } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import * as Credential from '../../Credential.js'
import type { MaybePromise } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from '../Methods.js'
import {
  getSubscriptionRpcAllowedCalls,
  signSubscriptionKeyAuthorization,
  toSubscriptionExpirySeconds,
  toSubscriptionPeriodSeconds,
  verifySubscriptionKeyAuthorization,
} from '../subscription/KeyAuthorization.js'
import type { SubscriptionAccessKey } from '../subscription/Types.js'

/** Context accepted by the Tempo subscription client method. */
export const subscriptionContextSchema = z.object({
  accessKey: z.optional(z.custom<SubscriptionAccessKey>()),
  account: z.optional(z.custom<Account.getResolver.Parameters['account']>()),
})

/** Runtime context for creating a Tempo subscription credential. */
export type SubscriptionContext = z.infer<typeof subscriptionContextSchema>

/** Creates a Tempo subscription client method. */
export function subscription(parameters: subscription.Parameters = {}) {
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  return Method.toClient(Methods.subscription, {
    context: subscriptionContextSchema,

    async createCredential({ challenge, context }) {
      const chainId = challenge.request.methodDetails?.chainId ?? defaults.chainId.mainnet
      const client = await getClient({ chainId })
      const account = getAccount(client, context)
      const accessKey =
        context?.accessKey ?? parameters.accessKey ?? challenge.request.methodDetails?.accessKey
      if (!accessKey) {
        throw new Error(
          'No `accessKey` provided. The subscription challenge must include `accessKey`, or the client must pass one to parameters/context.',
        )
      }

      if (parameters.expectedRecipients) {
        const recipient = (challenge.request.recipient as string).toLowerCase()
        const allowed = parameters.expectedRecipients.map((address) => address.toLowerCase())
        if (!allowed.includes(recipient)) {
          throw new Error(`Unexpected subscription recipient: ${challenge.request.recipient}`)
        }
      }
      if (parameters.expectedCurrencies) {
        const currency = (challenge.request.currency as string).toLowerCase()
        const allowed = parameters.expectedCurrencies.map((address) => address.toLowerCase())
        if (!allowed.includes(currency)) {
          throw new Error(`Unexpected subscription currency: ${challenge.request.currency}`)
        }
      }
      if (
        parameters.expectedPeriodSeconds &&
        challenge.request.periodSeconds !== parameters.expectedPeriodSeconds
      ) {
        throw new Error(`Unexpected subscription periodSeconds: ${challenge.request.periodSeconds}`)
      }
      if (
        parameters.maxAmount !== undefined &&
        BigInt(challenge.request.amount) > BigInt(parameters.maxAmount)
      ) {
        throw new Error(`Subscription amount exceeds maxAmount: ${challenge.request.amount}`)
      }

      toSubscriptionPeriodSeconds(challenge.request.periodSeconds)
      toSubscriptionExpirySeconds(challenge.request.subscriptionExpires)
      // The Tempo key authorization expiry becomes recurring billing authority, so bound it before signing.
      assertMaxSubscriptionExpires({
        maxSubscriptionExpires: parameters.maxSubscriptionExpires,
        subscriptionExpires: challenge.request.subscriptionExpires,
      })
      await parameters.validateRequest?.(challenge.request)

      const keyAuthorization = await authorizeAccessKey(client, {
        accessKey,
        account,
        chainId,
        request: challenge.request,
      } as never)

      const verified = verifySubscriptionKeyAuthorization({
        accessKey,
        chainId,
        payload: {
          signature: KeyAuthorization.serialize(keyAuthorization as never),
          type: 'keyAuthorization',
        },
        request: challenge.request,
      })
      if (!isAddressEqual(verified.source.address, account.address)) {
        throw new Error('keyAuthorization signer does not match the selected account')
      }

      return Credential.serialize({
        challenge,
        payload: {
          signature: KeyAuthorization.serialize(keyAuthorization as never),
          type: 'keyAuthorization',
        },
        source: `did:pkh:eip155:${chainId}:${account.address.toLowerCase()}`,
      })
    },
  })
}

async function authorizeAccessKey(
  client: Awaited<ReturnType<ReturnType<typeof Client.getResolver>>>,
  parameters: {
    accessKey: SubscriptionAccessKey
    account: Account.Account
    chainId: number
    request: Pick<
      ReturnType<typeof Methods.subscription.schema.request.parse>,
      'amount' | 'currency' | 'periodSeconds' | 'recipient' | 'subscriptionExpires'
    >
  },
) {
  const { accessKey, account, chainId, request } = parameters

  const local = await signSubscriptionKeyAuthorization({
    accessKey,
    account,
    chainId,
    request,
  })
  if (local) return local

  const result = (await client.request({
    method: 'wallet_authorizeAccessKey',
    params: [
      {
        address: accessKey.accessKeyAddress,
        allowedCalls: getSubscriptionRpcAllowedCalls(request),
        expiry: toSubscriptionExpirySeconds(request.subscriptionExpires),
        keyType: accessKey.keyType,
        limits: [
          {
            token: request.currency as Address,
            limit: BigInt(request.amount),
            period: toSubscriptionPeriodSeconds(request.periodSeconds),
          },
        ],
      },
    ],
  } as never)) as {
    keyAuthorization: Parameters<typeof KeyAuthorization.fromRpc>[0]
  }

  return KeyAuthorization.fromRpc(result.keyAuthorization)
}

function assertMaxSubscriptionExpires(parameters: {
  maxSubscriptionExpires: subscription.Parameters['maxSubscriptionExpires']
  subscriptionExpires: string
}) {
  const { maxSubscriptionExpires, subscriptionExpires } = parameters
  if (maxSubscriptionExpires === undefined) return

  const subscriptionExpiry = new Date(subscriptionExpires).getTime()
  const maxExpiry =
    typeof maxSubscriptionExpires === 'number'
      ? maxSubscriptionExpires
      : new Date(maxSubscriptionExpires).getTime()

  if (!Number.isFinite(maxExpiry)) {
    throw new Error('Invalid maxSubscriptionExpires')
  }
  if (subscriptionExpiry > maxExpiry) {
    throw new Error(`Subscription expiry exceeds maxSubscriptionExpires: ${subscriptionExpires}`)
  }
}

export declare namespace subscription {
  /** Parameters for creating a Tempo subscription credential. */
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      accessKey?: SubscriptionAccessKey | undefined
      expectedCurrencies?: readonly Address[] | undefined
      expectedPeriodSeconds?: string | undefined
      expectedRecipients?: readonly Address[] | undefined
      maxAmount?: string | bigint | undefined
      maxSubscriptionExpires?: string | number | Date | undefined
      validateRequest?:
        | ((
            request: ReturnType<typeof Methods.subscription.schema.request.parse>,
          ) => MaybePromise<void>)
        | undefined
    }
}
