import { Mppx as Mppx_client, evm as evm_client } from 'mppx/client'
import { Mppx, evm } from 'mppx/server'
import { describe, expect, test } from 'vp/test'
import { realm, secretKey, useChargeAnvil } from '~test/evm/charge.js'

describe('EVM transaction charge verifier', () => {
  const anvil = useChargeAnvil()

  test('settles a standard ERC-20 transfer transaction', async () => {
    const { fixture } = anvil
    const before = await anvil.balanceOf(fixture.token, fixture.recipient.address)
    const server = Mppx.create({
      methods: [
        evm({
          amount: '1',
          chainId: fixture.chain.id,
          credentialTypes: ['transaction'],
          currency: fixture.token,
          decimals: 6,
          getClient: () => fixture.serverClient,
          recipient: fixture.recipient.address,
        }),
      ],
      realm,
      secretKey,
    })
    const client = Mppx_client.create({
      methods: [
        evm_client({
          account: fixture.payer,
          credentialType: 'transaction',
          getClient: () => fixture.payerClient,
        }),
      ],
      polyfill: false,
    })

    const { receipt } = await anvil.settle({ client, server })

    expect(receipt).toMatchObject({
      chainId: fixture.chain.id,
      method: 'evm',
      status: 'success',
    })
    expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)
    await expect(anvil.balanceOf(fixture.token, fixture.recipient.address)).resolves.toBe(
      before + 1_000_000n,
    )
  })
})
