import { Mppx, Store, tempo } from 'mppx/server'
import { Subscription } from 'mppx/tempo'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const currency = '0x20c0000000000000000000000000000000000000' as const
const planId = 'monthly'
const pricePerSecond = '0.000001'
const periodSeconds = '1'
const subscriptionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString()

const account = privateKeyToAccount(generatePrivateKey())
const store = Store.memory()
const subscriptions = Subscription.fromStore(store)

type AccessKeyEntry = Subscription.SubscriptionAccessKey

const accessKeys = new Map<string, AccessKeyEntry>()
let sequence = 0

function subscriptionKey(userId: string) {
  return `news:${userId}:${planId}`
}

function getUserId(request: Request) {
  return request.headers.get('X-User-Id') ?? new URL(request.url).searchParams.get('userId')
}

function getAccessKey(key: string): AccessKeyEntry {
  const existing = accessKeys.get(key)
  if (existing) return existing

  const accessAccount = privateKeyToAccount(generatePrivateKey())
  const accessKey = {
    accessKeyAddress: accessAccount.address,
    keyType: 'secp256k1',
  } as const
  accessKeys.set(key, accessKey)
  return accessKey
}

function txHash() {
  sequence += 1
  return `0x${sequence.toString(16).padStart(64, '0')}` as const
}

function subscriptionId(userId: string) {
  return Buffer.from(`news:${userId}:${Date.now()}`).toString('base64url')
}

function chargeWithAccessKey(parameters: {
  accessKey: AccessKeyEntry
  amount: string
  periodIndex: number
  subscriptionId: string
}) {
  console.log(
    `[billing] accessKey=${parameters.accessKey.accessKeyAddress} subscription=${parameters.subscriptionId} period=${parameters.periodIndex} amount=${parameters.amount}`,
  )
  return txHash()
}

const mppx = Mppx.create({
  methods: [
    tempo.subscription({
      activate: async ({ accessKey, request, resolved }) => {
        const userId = resolved.key.split(':')[1] ?? 'anonymous'
        const id = subscriptionId(userId)
        const reference = chargeWithAccessKey({
          accessKey,
          amount: request.amount,
          periodIndex: 0,
          subscriptionId: id,
        })
        const record = {
          amount: request.amount,
          billingAnchor: new Date().toISOString(),
          chainId: request.methodDetails?.chainId,
          currency: request.currency,
          lastChargedPeriod: 0,
          lookupKey: resolved.key,
          periodSeconds: request.periodSeconds,
          recipient: request.recipient,
          reference,
          subscriptionExpires: request.subscriptionExpires,
          subscriptionId: id,
          timestamp: new Date().toISOString(),
        } satisfies Subscription.SubscriptionRecord

        return {
          receipt: Subscription.createSubscriptionReceipt(record),
          subscription: record,
        }
      },
      amount: pricePerSecond,
      chainId: 4217,
      currency,
      periodSeconds,
      recipient: account.address,
      resolve: async ({ input }) => {
        const userId = getUserId(input)
        if (!userId) return null
        const key = subscriptionKey(userId)
        return { accessKey: getAccessKey(key), key }
      },
      renew: async ({ periodIndex, subscription }) => {
        const accessKey = subscription.accessKey ?? getAccessKey(subscription.lookupKey)
        const reference = chargeWithAccessKey({
          accessKey,
          amount: subscription.amount,
          periodIndex,
          subscriptionId: subscription.subscriptionId,
        })
        const record = {
          ...subscription,
          lastChargedPeriod: periodIndex,
          reference,
          timestamp: new Date().toISOString(),
        }
        return {
          receipt: Subscription.createSubscriptionReceipt(record),
          subscription: record,
        }
      },
      store,
      subscriptionExpires,
      hooks: {
        activated: async ({ subscription }) => {
          console.log(`[subscription] activated ${subscription.subscriptionId}`)
        },
        renewed: async ({ periodIndex, subscription }) => {
          console.log(`[subscription] renewed ${subscription.subscriptionId} period=${periodIndex}`)
        },
      },
    }),
  ],
})

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

  if (url.pathname === '/api/subscription') {
    const userId = getUserId(request)
    if (!userId) return Response.json({ error: 'missing userId' }, { status: 400 })
    return Response.json(await subscriptions.getByKey(subscriptionKey(userId)))
  }

  if (url.pathname === '/api/article') {
    const result = await mppx.tempo.subscription({
      description: 'News app per-second subscription',
    })(request)

    if (result.status === 402) return result.challenge

    return result.withReceipt(
      Response.json({
        article: 'Tempo subscriptions let a news app sell access by the second.',
        plan: planId,
      }),
    )
  }

  return null
}
