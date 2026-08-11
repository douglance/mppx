import type { Address } from 'viem'

import { VerificationFailedError } from '../../Errors.js'
import * as Expires from '../../Expires.js'
import type { LooseOmit, NoExtraKeys } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Store from '../../Store.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import type * as z from '../../zod.js'
import * as Charge_internal from '../internal/charge.js'
import * as Methods from '../Methods.js'
import { verifyAuthorization } from './internal/charge-authorization.js'
import { verifyHash } from './internal/charge-hash.js'
import { verifyPermit2 } from './internal/charge-permit2.js'
import { verifyTransaction } from './internal/charge-transaction.js'

/**
 * Creates an EVM charge method intent for usage on the server.
 *
 * @example
 * ```ts
 * import { evm } from 'mppx/server'
 *
 * const charge = evm.charge({
 *   amount: '1',
 *   chainId: 1,
 *   currency: '0x...',
 *   decimals: 6,
 *   recipient: '0x...',
 *   rpcUrl: { 1: 'https://...' },
 * })
 * ```
 */
export function charge<const parameters extends charge.Parameters>(
  parameters: NoExtraKeys<parameters, charge.Parameters>,
) {
  const {
    amount,
    chainId,
    credentialTypes,
    currency,
    decimals,
    description,
    externalId,
    permit2Address,
    recipient,
    spender,
    splits,
  } = parameters
  const store = (parameters.store ?? Store.memory()) as Store.AtomicStore<charge.StoreItemMap>
  const getClient = Client.getResolver({
    getClient: parameters.getClient,
    rpcUrl: parameters.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  const resolvedCredentialTypes =
    credentialTypes ??
    Charge_internal.defaultCredentialTypes({
      authorization: !!parameters.authorizationDomain,
      serverPaysGas: !!parameters.account,
    })

  type Defaults = charge.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.charge, Defaults>(Methods.charge, {
    defaults: {
      amount,
      chainId,
      credentialTypes: resolvedCredentialTypes,
      currency,
      decimals,
      description,
      externalId,
      permit2Address,
      recipient,
      spender: spender ?? resolveAccountAddress(parameters.account),
      splits,
    } as unknown as Defaults,

    async request({ request }) {
      if (request.splits && request.credentialTypes?.some((type) => type !== 'permit2')) {
        return { ...request, credentialTypes: ['permit2'] }
      }
      return request
    },

    async verify({ credential, request }) {
      const { challenge } = credential
      const resolvedRequest = (() => {
        const parsed = Methods.charge.schema.request.safeParse(request)
        if (parsed.success) return parsed.data
        return request as unknown as z.output<typeof Methods.charge.schema.request>
      })()
      const methodDetails = resolvedRequest.methodDetails
      const resolvedChainId = methodDetails?.chainId ?? request.chainId
      if (resolvedChainId === undefined)
        throw new VerificationFailedError({ reason: 'EVM charge challenge is missing chainId.' })

      Expires.assert(challenge.expires, challenge.id)

      const payload = credential.payload
      if (methodDetails?.splits && payload.type !== 'permit2')
        throw new VerificationFailedError({ reason: 'Only Permit2 credentials support splits.' })

      const client = await getClient({ chainId: resolvedChainId })

      switch (payload.type) {
        case 'permit2':
          return verifyPermit2({
            challenge,
            client,
            credential: { payload, source: credential.source },
            getAccount,
            request: resolvedRequest,
            store,
          })
        case 'authorization':
          return verifyAuthorization({
            authorizationDomain: parameters.authorizationDomain,
            challenge,
            client,
            credential: { payload, source: credential.source },
            getAccount,
            request: resolvedRequest,
            store,
          })
        case 'transaction':
          return verifyTransaction({
            client,
            challenge,
            payload,
            request: resolvedRequest,
            store,
          })
        case 'hash':
          return verifyHash({ challenge, client, payload, request: resolvedRequest, store })
        default:
          throw new VerificationFailedError({ reason: 'Unsupported EVM credential type.' })
      }
    },
  })
}

export declare namespace charge {
  type StoreItemMap = import('./internal/charge-types.js').StoreItemMap

  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.charge>, never>

  type AuthorizationDomain = import('./internal/charge-types.js').AuthorizationDomain

  type Parameters = {
    /** Account used by the server to submit Permit2 and EIP-3009 transactions. */
    account?: Account.getResolver.Parameters['account'] | undefined
    /** EIP-3009 typed-data domain resolver. Enables `type="authorization"`. */
    authorizationDomain?: AuthorizationDomain | undefined
    /** Store for atomic replay protection. */
    store?: Store.AtomicStore | undefined
  } & Client.getResolver.Parameters &
    Defaults & {
      /** RPC URLs keyed by chain ID. */
      rpcUrl?: ({ [chainId: number]: string } & object) | undefined
    }

  type DeriveDefaults<parameters extends Parameters> = Pick<
    parameters,
    Extract<keyof parameters, keyof Defaults>
  >
}

function resolveAccountAddress(account: charge.Parameters['account']): Address | undefined {
  if (!account) return undefined
  if (typeof account === 'string') return account as Address
  return account.address
}
