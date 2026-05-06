import * as Store from '../../Store.js'
import type { SubscriptionRecord } from './Types.js'

const defaultRecordPrefix = 'tempo:subscription:record:'
const defaultKeyPrefix = 'tempo:subscription:key:'

/** Subscription-aware wrapper around a generic key-value store. */
export type SubscriptionStore = {
  /** Atomically marks a subscription period as being renewed. */
  beginRenewal: (subscriptionId: string, periodIndex: number) => Promise<BeginRenewalResult>
  /** Atomically stores a successful renewal and clears the in-flight marker. */
  commitRenewal: (subscription: SubscriptionRecord, periodIndex: number) => Promise<void>
  /** Clears an in-flight renewal marker after a failed renewal attempt. */
  failRenewal: (subscriptionId: string, periodIndex: number) => Promise<void>
  /** Looks up a subscription by subscription ID. */
  get: (subscriptionId: string) => Promise<SubscriptionRecord | null>
  /** Looks up the active subscription for a resolved request key. */
  getByKey: (key: string) => Promise<SubscriptionRecord | null>
  /** Upserts a subscription record and marks it as active for its lookup key. */
  put: (record: SubscriptionRecord) => Promise<void>
}

/** Result from attempting to mark a subscription period as in-flight. */
export type BeginRenewalResult =
  | { status: 'started'; subscription: SubscriptionRecord }
  | { status: 'charged'; subscription: SubscriptionRecord }
  | { status: 'inFlight'; subscription: SubscriptionRecord }
  | { status: 'missing' }

/** Wraps a generic key-value {@link Store.Store} with subscription-specific accessors. */
export function fromStore(
  store: Store.AtomicStore<Record<string, unknown>>,
  options?: fromStore.Options,
): SubscriptionStore {
  const recordPrefix = options?.recordPrefix ?? defaultRecordPrefix
  const keyPrefix = options?.keyPrefix ?? defaultKeyPrefix

  function recordKey(subscriptionId: string): string {
    return `${recordPrefix}${subscriptionId}`
  }

  function lookupKey(key: string): string {
    return `${keyPrefix}${key}`
  }

  return {
    async beginRenewal(subscriptionId, periodIndex) {
      return store.update(
        recordKey(subscriptionId),
        (current): Store.Change<unknown, BeginRenewalResult> => {
          const subscription = current as SubscriptionRecord | null
          if (!subscription) return { op: 'noop', result: { status: 'missing' as const } }
          if (subscription.lastChargedPeriod >= periodIndex) {
            return {
              op: 'noop',
              result: { status: 'charged' as const, subscription },
            }
          }
          if (subscription.inFlightPeriod === periodIndex) {
            return {
              op: 'noop',
              result: { status: 'inFlight' as const, subscription },
            }
          }

          const next = {
            ...subscription,
            inFlightPeriod: periodIndex,
            inFlightStartedAt: new Date().toISOString(),
          }
          return {
            op: 'set',
            value: next,
            result: { status: 'started' as const, subscription: next },
          }
        },
      )
    },

    async commitRenewal(subscription, periodIndex) {
      await store.update(recordKey(subscription.subscriptionId), (current) => {
        const existing = current as SubscriptionRecord | null
        if (!existing || existing.inFlightPeriod !== periodIndex) {
          return { op: 'noop', result: undefined }
        }

        return {
          op: 'set',
          value: {
            ...subscription,
            inFlightPeriod: undefined,
            inFlightReference: undefined,
            inFlightStartedAt: undefined,
            lastChargedPeriod: periodIndex,
          },
          result: undefined,
        }
      })
      await store.put(lookupKey(subscription.lookupKey), subscription.subscriptionId)
    },

    async failRenewal(subscriptionId, periodIndex) {
      await store.update(recordKey(subscriptionId), (current) => {
        const subscription = current as SubscriptionRecord | null
        if (!subscription || subscription.inFlightPeriod !== periodIndex) {
          return { op: 'noop', result: undefined }
        }
        return {
          op: 'set',
          value: {
            ...subscription,
            inFlightPeriod: undefined,
            inFlightReference: undefined,
            inFlightStartedAt: undefined,
          },
          result: undefined,
        }
      })
    },

    async get(subscriptionId) {
      return (await store.get(recordKey(subscriptionId))) as SubscriptionRecord | null
    },

    /** Looks up the active subscription for a resolved request key. */
    async getByKey(key) {
      const id = (await store.get(lookupKey(key))) as string | null
      if (!id) return null
      return (await store.get(recordKey(id))) as SubscriptionRecord | null
    },

    /** Upserts a subscription record and marks it as active for its lookup key. */
    async put(record) {
      await store.put(recordKey(record.subscriptionId), record)
      await store.put(lookupKey(record.lookupKey), record.subscriptionId)
    },
  }
}

export declare namespace fromStore {
  type Options = {
    /** Key prefix for subscription records. @default `'tempo:subscription:record:'` */
    recordPrefix?: string | undefined
    /** Key prefix for resolved request keys. @default `'tempo:subscription:key:'` */
    keyPrefix?: string | undefined
  }
}
