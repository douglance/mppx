import { isAddressEqual, type Address } from 'viem'

import { VerificationFailedError } from '../../Errors.js'
import type { LooseOmit, MaybePromise, NoExtraKeys } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Store from '../../Store.js'
import * as Client from '../../viem/Client.js'
import * as Account from '../internal/account.js'
import * as defaults from '../internal/defaults.js'
import * as Proof from '../internal/proof.js'
import type * as types from '../internal/types.js'
import * as Methods from '../Methods.js'
import {
  assertSubscriptionTiming,
  verifySubscriptionKeyAuthorization,
} from '../subscription/KeyAuthorization.js'
import * as SubscriptionReceipt from '../subscription/Receipt.js'
import * as SubscriptionStore from '../subscription/Store.js'
import type {
  SubscriptionAccessKey,
  SubscriptionCredentialPayload,
  SubscriptionLookup,
  SubscriptionRecord,
  SubscriptionReceipt as SubscriptionReceiptValue,
} from '../subscription/Types.js'

type SubscriptionRequest = ReturnType<typeof Methods.subscription.schema.request.parse>

/**
 * Creates a Tempo subscription method for recurring TIP-20 token payments.
 *
 * The method handles activation, request-path reuse, and optional lazy renewals.
 */
export function subscription<const parameters extends subscription.Parameters>(
  p: NoExtraKeys<parameters, subscription.Parameters>,
) {
  const parameters = p as parameters
  if (!parameters.store) {
    throw new Error(
      'tempo.subscription() requires a `store` so subscriptions can be reused and renewed.',
    )
  }
  if (typeof parameters.store.update !== 'function') {
    throw new Error('tempo.subscription() requires an atomic store with `update`.')
  }
  const {
    amount,
    currency = defaults.resolveCurrency(parameters),
    decimals = defaults.decimals,
    description,
    externalId,
    periodSeconds,
    store: rawStore,
    subscriptionExpires,
  } = parameters

  const store = SubscriptionStore.fromStore(rawStore)
  const getClient = Client.getResolver({
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const { recipient } = Account.resolve(parameters)

  type Defaults = subscription.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.subscription, Defaults>(Methods.subscription, {
    defaults: {
      amount,
      currency,
      decimals,
      description,
      externalId,
      periodSeconds,
      recipient,
      subscriptionExpires,
    } as unknown as Defaults,

    async authorize({ input, request }) {
      const resolved = await parameters.resolve({ input, request })
      if (!resolved) return undefined

      const subscription = await store.getByKey(resolved.key)
      if (!subscription || !isActive(subscription)) return undefined

      const periodIndex = getPeriodIndex(subscription)
      if (periodIndex > subscription.lastChargedPeriod) {
        if (!parameters.renew) return undefined

        const renewal = await settleRenewal({
          expectedLookupKey: resolved.key,
          periodIndex,
          renew: parameters.renew,
          request,
          store,
          subscription,
        })
        if (!renewal) return undefined
        if (renewal.status === 'charged') return { receipt: renewal.receipt }

        await parameters.hooks?.renewed?.({
          periodIndex,
          receipt: renewal.result.receipt,
          subscription: renewal.result.subscription,
        })
        return {
          receipt: renewal.result.receipt,
        }
      }

      return {
        receipt: SubscriptionReceipt.fromRecord(subscription),
      }
    },

    async request({ capturedRequest, credential, request }) {
      const chainId = await (async () => {
        if (request.chainId) return request.chainId
        if (parameters.chainId) return parameters.chainId
        if (parameters.testnet) return defaults.chainId.testnet
        return (await getClient({})).chain?.id ?? defaults.chainId.mainnet
      })()
      const parsedRequest = Methods.subscription.schema.request.parse({
        ...request,
        chainId,
      })
      const input = capturedRequest
        ? new Request(capturedRequest.url, {
            headers: capturedRequest.headers,
            method: capturedRequest.method,
          })
        : new Request('https://subscription.invalid')
      const resolved = await parameters.resolve({ input, request: parsedRequest })
      const accessKey =
        resolved && !credential
          ? await resolveAccessKey({ input, parameters, request: parsedRequest, resolved })
          : parsedRequest.accessKey

      return {
        ...request,
        ...(accessKey ? { accessKey } : {}),
        chainId,
      }
    },

    stableBinding(request) {
      return subscriptionBinding(request)
    },

    async verify({ credential, envelope, request }) {
      const input = envelope
        ? new Request(envelope.capturedRequest.url, {
            headers: envelope.capturedRequest.headers,
            method: envelope.capturedRequest.method,
          })
        : new Request('https://subscription.invalid')
      const parsedRequest = Methods.subscription.schema.request.parse(request)
      assertSubscriptionTiming({
        challengeExpires: credential.challenge.expires,
        request: parsedRequest,
      })
      const resolved = await parameters.resolve({ input, request: parsedRequest })

      if (!resolved) {
        throw new VerificationFailedError({ reason: 'subscription could not be resolved' })
      }
      const challengeRequest = credential.challenge.request as SubscriptionRequest
      const accessKey =
        challengeRequest.accessKey ??
        parsedRequest.accessKey ??
        (await resolveAccessKey({ input, parameters, request: parsedRequest, resolved }))
      if (!accessKey) {
        throw new VerificationFailedError({ reason: 'subscription accessKey is missing' })
      }
      const verified = verifySubscriptionKeyAuthorization({
        accessKey,
        chainId: parsedRequest.methodDetails?.chainId ?? defaults.chainId.mainnet,
        payload: credential.payload as SubscriptionCredentialPayload,
        request: parsedRequest,
      })
      const declaredSource = credential.source ? Proof.parseProofSource(credential.source) : null
      if (
        declaredSource &&
        (declaredSource.chainId !== verified.source.chainId ||
          !isAddressEqual(declaredSource.address, verified.source.address))
      ) {
        throw new VerificationFailedError({ reason: 'credential source does not match signature' })
      }

      const activation = withSubscriptionAccessKey(
        await parameters.activate({
          accessKey,
          credential: credential as typeof credential & {
            payload: SubscriptionCredentialPayload
          },
          input,
          request: parsedRequest,
          resolved,
          source: verified.source,
        }),
        accessKey,
      )

      validateSubscriptionSettlement(activation, {
        expectedLookupKey: resolved.key,
        expectedPeriodIndex: 0,
        request: parsedRequest,
      })

      await store.put(activation.subscription)
      await parameters.hooks?.activated?.({
        receipt: activation.receipt,
        subscription: activation.subscription,
      })
      return activation.receipt
    },
  })
}

async function resolveAccessKey(parameters: {
  input: Request
  parameters: subscription.Parameters
  request: SubscriptionRequest
  resolved: subscription.ResolvedSubscription
}) {
  const { input, parameters: subscriptionParameters, request, resolved } = parameters
  return (
    resolved.accessKey ??
    (subscriptionParameters.accessKey
      ? await subscriptionParameters.accessKey({ input, request, resolved })
      : undefined)
  )
}

async function settleRenewal(parameters: {
  expectedLookupKey: string
  periodIndex: number
  renew: (parameters: {
    periodIndex: number
    subscription: SubscriptionRecord
  }) => Promise<subscription.RenewalResult>
  request?: SubscriptionRequest | undefined
  store: SubscriptionStore.SubscriptionStore
  subscription: SubscriptionRecord
}): Promise<
  | { status: 'charged'; receipt: SubscriptionReceiptValue }
  | { status: 'renewed'; result: subscription.RenewalResult }
  | null
> {
  const { expectedLookupKey, periodIndex, renew, request, store, subscription } = parameters
  const started = await store.beginRenewal(subscription.subscriptionId, periodIndex)
  if (started.status === 'charged') {
    return { receipt: SubscriptionReceipt.fromRecord(started.subscription), status: 'charged' }
  }
  if (started.status !== 'started') return null

  const renewed = withSubscriptionAccessKey(
    await renew({ periodIndex, subscription: started.subscription }).catch(async (error) => {
      await store.failRenewal(subscription.subscriptionId, periodIndex)
      throw error
    }),
    started.subscription.accessKey,
  )
  validateSubscriptionSettlement(renewed, {
    expectedLookupKey,
    expectedPeriodIndex: periodIndex,
    request,
  })
  await store.commitRenewal(renewed.subscription, periodIndex)
  return { result: renewed, status: 'renewed' }
}

function withSubscriptionAccessKey<
  result extends subscription.ActivationResult | subscription.RenewalResult,
>(result: result, accessKey: SubscriptionAccessKey | undefined): result {
  if (!accessKey || result.subscription.accessKey) return result
  return {
    ...result,
    subscription: {
      ...result.subscription,
      accessKey,
    },
  }
}

function getPeriodIndex(subscription: SubscriptionRecord): number {
  const anchor = new Date(subscription.billingAnchor).getTime()
  const expires = new Date(subscription.subscriptionExpires).getTime()
  const now = Date.now()
  if (!Number.isFinite(anchor) || !Number.isFinite(expires) || now >= expires) {
    return Number.POSITIVE_INFINITY
  }

  const periodSeconds = Number(subscription.periodSeconds)
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds <= 0) {
    return Number.POSITIVE_INFINITY
  }

  return Math.max(0, Math.floor((now - anchor) / (periodSeconds * 1_000)))
}

function isActive(subscription: SubscriptionRecord): boolean {
  if (subscription.canceledAt || subscription.revokedAt) return false
  return new Date(subscription.subscriptionExpires).getTime() > Date.now()
}

function validateSubscriptionSettlement(
  result: subscription.ActivationResult | subscription.RenewalResult,
  options: {
    expectedLookupKey: string
    expectedPeriodIndex: number
    request?: SubscriptionRequest | undefined
  },
) {
  const { receipt, subscription } = result
  assertSubscriptionReceipt(receipt, subscription)
  assertSubscriptionRecord(subscription, options)

  if (options.request) {
    assertSubscriptionRequestMatch(subscription, options.request)
  }
}

function assertSubscriptionReceipt(
  receipt: SubscriptionReceiptValue,
  subscription: SubscriptionRecord,
) {
  if (receipt.method !== 'tempo' || receipt.status !== 'success') {
    throw new VerificationFailedError({ reason: 'subscription receipt is invalid' })
  }
  if (receipt.subscriptionId !== subscription.subscriptionId) {
    throw new VerificationFailedError({ reason: 'subscription receipt id mismatch' })
  }
  if (receipt.reference !== subscription.reference) {
    throw new VerificationFailedError({ reason: 'subscription receipt reference mismatch' })
  }
  if (receipt.timestamp !== subscription.timestamp) {
    throw new VerificationFailedError({ reason: 'subscription receipt timestamp mismatch' })
  }
  assertTransactionHash(receipt.reference, 'subscription reference must be a transaction hash')
  assertValidDate(receipt.timestamp, 'subscription receipt timestamp is invalid')
}

function assertSubscriptionRecord(
  subscription: SubscriptionRecord,
  options: {
    expectedLookupKey: string
    expectedPeriodIndex: number
  },
) {
  assertBase64Url(subscription.subscriptionId, 'subscriptionId must be base64url')
  assertTransactionHash(subscription.reference, 'subscription reference must be a transaction hash')
  const billingAnchor = assertValidDate(
    subscription.billingAnchor,
    'subscription billingAnchor is invalid',
  )
  const subscriptionExpires = assertValidDate(
    subscription.subscriptionExpires,
    'subscriptionExpires is invalid',
  )

  assertEqual(subscription.lookupKey, options.expectedLookupKey, {
    reason: 'subscription lookupKey does not match the resolved key',
  })
  assertEqual(subscription.lastChargedPeriod, options.expectedPeriodIndex, {
    reason: 'subscription lastChargedPeriod does not match the settled period',
  })
  if (billingAnchor >= subscriptionExpires) {
    throw new VerificationFailedError({
      reason: 'subscription billingAnchor must be before subscriptionExpires',
    })
  }
}

function assertSubscriptionRequestMatch(
  subscription: SubscriptionRecord,
  request: SubscriptionRequest,
) {
  const matches =
    subscription.amount === request.amount &&
    subscription.chainId === request.methodDetails?.chainId &&
    subscription.currency.toLowerCase() === request.currency.toLowerCase() &&
    subscription.externalId === request.externalId &&
    subscription.periodSeconds === request.periodSeconds &&
    subscription.recipient.toLowerCase() === request.recipient.toLowerCase() &&
    subscription.subscriptionExpires === request.subscriptionExpires

  if (!matches) {
    throw new VerificationFailedError({ reason: 'subscription record does not match request' })
  }
}

function assertBase64Url(value: string, reason: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new VerificationFailedError({ reason })
  }
}

function assertTransactionHash(value: string, reason: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new VerificationFailedError({ reason })
  }
}

function assertValidDate(value: string, reason: string) {
  const milliseconds = new Date(value).getTime()
  if (!Number.isFinite(milliseconds)) {
    throw new VerificationFailedError({ reason })
  }
  return milliseconds
}

function assertEqual<value>(actual: value, expected: value, options: { reason: string }) {
  if (actual !== expected) {
    throw new VerificationFailedError(options)
  }
}

function subscriptionBinding(request: SubscriptionRequest) {
  return {
    amount: request.amount,
    chainId: request.methodDetails?.chainId,
    currency: request.currency,
    periodSeconds: request.periodSeconds,
    recipient: request.recipient,
    subscriptionExpires: request.subscriptionExpires,
  }
}

/**
 * Renews an overdue subscription outside of the HTTP request path.
 * Intended for cron jobs or background workers that bill subscriptions on a schedule.
 *
 * Returns the renewal result if the subscription was overdue, or `null` if already current.
 */
export async function renew(parameters: renew.Parameters): Promise<renew.Result | null> {
  const { renew, store: rawStore } = parameters
  const store = SubscriptionStore.fromStore(rawStore)

  const record = await store.get(parameters.subscriptionId)
  if (!record) return null
  if (!isActive(record)) return null

  const periodIndex = getPeriodIndex(record)
  if (periodIndex <= record.lastChargedPeriod) return null

  const renewal = await settleRenewal({
    expectedLookupKey: record.lookupKey,
    periodIndex,
    renew,
    store,
    subscription: record,
  })
  return renewal?.status === 'renewed' ? renewal.result : null
}

export declare namespace renew {
  /** Parameters for renewing an overdue subscription outside the request path. */
  type Parameters = {
    /** The subscription to renew. */
    subscriptionId: string
    /** Billing callback — same signature as the `renew` hook on {@link subscription}. */
    renew: (parameters: {
      periodIndex: number
      subscription: SubscriptionRecord
    }) => Promise<subscription.RenewalResult>
    /** Store containing subscription records. */
    store: Store.AtomicStore<Record<string, unknown>>
  }

  /** Renewal result returned by {@link renew}. */
  type Result = subscription.RenewalResult
}

export declare namespace subscription {
  /** Request-scoped lookup key used to find the active subscription. */
  type ResolvedSubscription = SubscriptionLookup

  /** Activation result returned after the initial credential is verified. */
  type ActivationResult = {
    receipt: SubscriptionReceiptValue
    subscription: SubscriptionRecord
  }

  /** Renewal result returned when an overdue subscription is charged. */
  type RenewalResult = {
    receipt: SubscriptionReceiptValue
    subscription: SubscriptionRecord
  }

  /** Request defaults supported by the subscription method. */
  type Defaults = LooseOmit<
    Method.RequestDefaults<typeof Methods.subscription>,
    'accessKey' | 'recipient'
  >

  /** Parameters for configuring a Tempo subscription method. */
  type Parameters = Account.resolve.Parameters &
    Client.getResolver.Parameters & {
      accessKey?:
        | ((parameters: {
            input: Request
            request: SubscriptionRequest
            resolved: ResolvedSubscription
          }) => MaybePromise<SubscriptionAccessKey>)
        | undefined
      activate: (parameters: {
        accessKey: SubscriptionAccessKey
        credential: {
          payload: SubscriptionCredentialPayload
          source?: string | undefined
        }
        input: Request
        request: SubscriptionRequest
        resolved: ResolvedSubscription
        source: { address: Address; chainId: number } | null
      }) => Promise<ActivationResult>
      hooks?:
        | {
            activated?:
              | ((parameters: {
                  receipt: SubscriptionReceiptValue
                  subscription: SubscriptionRecord
                }) => MaybePromise<void>)
              | undefined
            renewed?:
              | ((parameters: {
                  periodIndex: number
                  receipt: SubscriptionReceiptValue
                  subscription: SubscriptionRecord
                }) => MaybePromise<void>)
              | undefined
          }
        | undefined
      periodSeconds?: string | undefined
      resolve: (parameters: {
        input: Request
        request: SubscriptionRequest
      }) => MaybePromise<ResolvedSubscription | null>
      renew?: (parameters: {
        periodIndex: number
        subscription: SubscriptionRecord
      }) => Promise<RenewalResult>
      store: Store.AtomicStore<Record<string, unknown>>
      testnet?: boolean | undefined
    } & Defaults

  /** Derived defaults after account and chain configuration are applied. */
  type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  > & {
    decimals: number
  }
}
