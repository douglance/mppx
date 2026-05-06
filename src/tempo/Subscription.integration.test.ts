import { Receipt } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as Store from '../Store.js'
import { createSubscriptionReceipt } from './subscription/Receipt.js'
import * as SubscriptionStore from './subscription/Store.js'
import type { SubscriptionAccessKey, SubscriptionRecord } from './subscription/Types.js'

const realm = 'news.example.com'
const secretKey = 'subscription-lifecycle-secret'
const currency = '0x20c0000000000000000000000000000000000001'
const recipient = '0x1234567890abcdef1234567890abcdef12345678'
const periodSeconds = '2592000'
const subscriptionExpires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString()
const userId = 'user-1'
const planId = 'monthly'
const subscriptionKey = `news:${userId}:${planId}`
const rootAccount = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)
const accessAccount = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000002',
)
const accessKey = {
  accessKeyAddress: accessAccount.address,
  keyType: 'secp256k1',
} as const satisfies SubscriptionAccessKey

function txHash(index: number) {
  return `0x${index.toString(16).padStart(64, '0')}` as const
}

function timestamp(index: number) {
  return new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString()
}

function receiptFor(record: SubscriptionRecord) {
  return createSubscriptionReceipt(record)
}

describe('tempo subscription lifecycle integration', () => {
  test('runs a news app subscription from activation through reuse, renewal, cancellation, and reactivation', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const events: string[] = []
    const resolvedKeys: string[] = []
    let activationCount = 0
    let renewalCount = 0

    const server = Mppx_server.create({
      methods: [
        tempo_server.subscription({
          activate: async ({ request, resolved, source }) => {
            activationCount += 1
            const record = {
              amount: request.amount,
              billingAnchor: new Date().toISOString(),
              chainId: request.methodDetails?.chainId,
              currency: request.currency,
              lastChargedPeriod: 0,
              lookupKey: resolved.key,
              periodSeconds: request.periodSeconds,
              recipient: request.recipient,
              reference: txHash(activationCount),
              subscriptionExpires: request.subscriptionExpires,
              subscriptionId: `sub_${activationCount}`,
              timestamp: timestamp(activationCount),
            } satisfies SubscriptionRecord

            events.push(`activated:${record.subscriptionId}:${source?.address.toLowerCase()}`)
            return {
              receipt: receiptFor(record),
              subscription: record,
            }
          },
          amount: '1',
          chainId: 4217,
          currency,
          periodSeconds,
          recipient,
          resolve: async ({ input }) => {
            const requestedUserId = input.headers.get('X-User-Id')
            if (!requestedUserId) return null
            const key = `news:${requestedUserId}:${planId}`
            resolvedKeys.push(key)
            if (key !== subscriptionKey) throw new Error('unknown subscription key')
            return { accessKey, key }
          },
          renew: async ({ periodIndex, subscription }) => {
            renewalCount += 1
            const record = {
              ...subscription,
              lastChargedPeriod: periodIndex,
              reference: txHash(100 + renewalCount),
              timestamp: timestamp(100 + renewalCount),
            }

            events.push(`renewed:${record.subscriptionId}:${periodIndex}`)
            return {
              receipt: receiptFor(record),
              subscription: record,
            }
          },
          store,
          subscriptionExpires,
          hooks: {
            activated: async ({ subscription }) => {
              events.push(`hook:activated:${subscription.subscriptionId}`)
            },
            renewed: async ({ periodIndex, subscription }) => {
              events.push(`hook:renewed:${subscription.subscriptionId}:${periodIndex}`)
            },
          },
        }),
      ],
      realm,
      secretKey,
    })

    const appFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const result = await server.tempo.subscription({})(request)
      if (result.status === 402) return result.challenge
      return result.withReceipt(
        Response.json({
          article: 'paid article',
          userId: request.headers.get('X-User-Id'),
        }),
      )
    }

    const client = Mppx_client.create({
      fetch: appFetch,
      methods: [
        tempo_client.subscription({
          account: rootAccount,
          expectedCurrencies: [currency],
          expectedPeriodSeconds: periodSeconds,
          expectedRecipients: [recipient],
          getClient: async () =>
            ({
              request: async () => {
                throw new Error('wallet_authorizeAccessKey should not be called for local account')
              },
            }) as never,
          maxAmount: 1_000_000n,
        }),
      ],
      polyfill: false,
    })

    const request = {
      headers: { 'X-User-Id': userId },
    } as const

    const activated = await client.fetch('https://news.example.com/articles/tempo', request)
    expect(activated.status).toBe(200)
    expect((await activated.clone().json()).article).toBe('paid article')
    expect(Receipt.fromResponse(activated).subscriptionId).toBe('sub_1')
    expect(activationCount).toBe(1)
    expect(resolvedKeys.at(0)).toBe(subscriptionKey)
    expect(await subscriptions.getByKey(subscriptionKey)).toMatchObject({
      accessKey: {
        accessKeyAddress: accessKey.accessKeyAddress.toLowerCase(),
        keyType: accessKey.keyType,
      },
      amount: '1000000',
      lastChargedPeriod: 0,
      lookupKey: subscriptionKey,
      periodSeconds,
      subscriptionId: 'sub_1',
    })

    const reused = await client.fetch('https://news.example.com/articles/tempo', request)
    expect(reused.status).toBe(200)
    expect(Receipt.fromResponse(reused).subscriptionId).toBe('sub_1')
    expect(activationCount).toBe(1)
    expect(renewalCount).toBe(0)

    const active = await subscriptions.get('sub_1')
    if (!active) throw new Error('expected active subscription')
    await subscriptions.put({
      ...active,
      billingAnchor: new Date(Date.now() - 3 * Number(periodSeconds) * 1_000).toISOString(),
      lastChargedPeriod: 0,
      reference: txHash(99),
      timestamp: timestamp(99),
    })

    const renewed = await client.fetch('https://news.example.com/articles/tempo', request)
    expect(renewed.status).toBe(200)
    expect(Receipt.fromResponse(renewed).subscriptionId).toBe('sub_1')
    expect(renewalCount).toBe(1)
    const afterRequestRenewal = await subscriptions.get('sub_1')
    expect(afterRequestRenewal?.lastChargedPeriod).toBeGreaterThan(0)
    expect(afterRequestRenewal?.inFlightPeriod).toBe(undefined)

    if (!afterRequestRenewal) throw new Error('expected renewed subscription')
    await subscriptions.put({
      ...afterRequestRenewal,
      billingAnchor: new Date(Date.now() - 5 * Number(periodSeconds) * 1_000).toISOString(),
      lastChargedPeriod: 1,
      reference: txHash(199),
      timestamp: timestamp(199),
    })
    const backgroundRenewal = await tempo_server.renewSubscription({
      renew: async ({ periodIndex, subscription }) => {
        renewalCount += 1
        const record = {
          ...subscription,
          lastChargedPeriod: periodIndex,
          reference: txHash(100 + renewalCount),
          timestamp: timestamp(100 + renewalCount),
        }
        events.push(`background:${record.subscriptionId}:${periodIndex}`)
        return {
          receipt: receiptFor(record),
          subscription: record,
        }
      },
      store,
      subscriptionId: 'sub_1',
    })
    expect(backgroundRenewal?.subscription.subscriptionId).toBe('sub_1')
    expect(
      await tempo_server.renewSubscription({
        renew: async () => {
          throw new Error('already renewed period should not be charged again')
        },
        store,
        subscriptionId: 'sub_1',
      }),
    ).toBe(null)

    const current = await subscriptions.get('sub_1')
    if (!current) throw new Error('expected subscription before cancellation')
    await subscriptions.put({
      ...current,
      canceledAt: timestamp(240),
    })

    const canceledProbe = await appFetch('https://news.example.com/articles/tempo', {
      headers: { 'X-User-Id': userId },
    })
    expect(canceledProbe.status).toBe(402)

    const reactivated = await client.fetch('https://news.example.com/articles/tempo', request)
    expect(reactivated.status).toBe(200)
    expect(Receipt.fromResponse(reactivated).subscriptionId).toBe('sub_2')
    expect(activationCount).toBe(2)
    expect((await subscriptions.getByKey(subscriptionKey))?.subscriptionId).toBe('sub_2')

    expect(resolvedKeys.every((key) => key === subscriptionKey)).toBe(true)
    expect(events).toEqual(
      expect.arrayContaining([
        `activated:sub_1:${rootAccount.address.toLowerCase()}`,
        'hook:activated:sub_1',
        expect.stringMatching(/^renewed:sub_1:\d+$/),
        expect.stringMatching(/^hook:renewed:sub_1:\d+$/),
        expect.stringMatching(/^background:sub_1:\d+$/),
        `activated:sub_2:${rootAccount.address.toLowerCase()}`,
        'hook:activated:sub_2',
      ]),
    )
  })
})
