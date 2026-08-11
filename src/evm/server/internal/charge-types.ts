import type { Address, TypedDataDomain } from 'viem'

import type * as Store from '../../../Store.js'
import type * as Account from '../../../viem/Account.js'
import type * as z from '../../../zod.js'
import type * as Methods from '../../Methods.js'

export type Challenge = { id: string; realm: string; expires?: string | undefined }

export type Request = z.output<typeof Methods.charge.schema.request>

export type StoreItemMap = { [key: `mppx:evm:charge:${string}`]: number }

export type ChargeStore = Store.AtomicStore<StoreItemMap>

export type GetAccount = ReturnType<typeof Account.getResolver>

export type AuthorizationDomain =
  | TypedDataDomain
  | ((parameters: {
      chainId: number
      currency: Address
    }) => Promise<TypedDataDomain> | TypedDataDomain)
