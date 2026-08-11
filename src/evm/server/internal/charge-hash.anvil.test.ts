import { Receipt } from 'mppx'
import { Mppx as Mppx_client, evm as evm_client } from 'mppx/client'
import { Mppx, evm } from 'mppx/server'
import { describe, expect, test } from 'vp/test'
import { realm, secretKey, useChargeAnvil } from '~test/evm/charge.js'

describe('EVM hash charge verifier', () => {
  const anvil = useChargeAnvil()

  test('verifies a client-broadcast ERC-20 transfer hash and rejects replay', async () => {
    const { fixture } = anvil
    const before = await anvil.balanceOf(fixture.token, fixture.recipient.address)
    const { client, server } = createHashCharge(fixture)

    const { authorization, receipt } = await anvil.settle({ client, server })

    expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)
    await expect(anvil.balanceOf(fixture.token, fixture.recipient.address)).resolves.toBe(
      before + 1_000_000n,
    )

    const replay = await server.charge({ expires: anvil.expires() })(
      new Request('https://api.example.com/resource', {
        headers: { Authorization: authorization },
      }),
    )

    expect(replay.status).toBe(402)
    if (replay.status !== 402) throw new Error('Expected replay to be rejected.')
    await expect(replay.challenge.json()).resolves.toMatchObject({
      status: 402,
      title: 'Verification Failed',
    })
  })

  test('allows retry after the transaction is mined', async () => {
    const { fixture } = anvil
    const before = await anvil.balanceOf(fixture.token, fixture.recipient.address)
    const { client, server } = createHashCharge(fixture)

    await anvil.anvilRequest('evm_setAutomine', [false])
    try {
      const challenge = await server.charge({ expires: anvil.expires() })(
        new Request('https://api.example.com/resource'),
      )
      expect(challenge.status).toBe(402)
      if (challenge.status !== 402) throw new Error('Expected an EVM charge challenge.')

      const authorization = await client.createCredential(challenge.challenge)
      const pending = await server.charge({ expires: anvil.expires() })(
        new Request('https://api.example.com/resource', {
          headers: { Authorization: authorization },
        }),
      )
      expect(pending.status).toBe(402)

      await anvil.anvilRequest('evm_mine', [])

      const settled = await server.charge({ expires: anvil.expires() })(
        new Request('https://api.example.com/resource', {
          headers: { Authorization: authorization },
        }),
      )
      expect(settled.status).toBe(200)
      if (settled.status !== 200) throw new Error('Expected retry to settle.')
      const receipt = Receipt.fromResponse(settled.withReceipt(new Response('ok')))
      expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)
      await expect(anvil.balanceOf(fixture.token, fixture.recipient.address)).resolves.toBe(
        before + 1_000_000n,
      )

      const replay = await server.charge({ expires: anvil.expires() })(
        new Request('https://api.example.com/resource', {
          headers: { Authorization: authorization },
        }),
      )
      expect(replay.status).toBe(402)
    } finally {
      await anvil.anvilRequest('evm_setAutomine', [true])
      await anvil.anvilRequest('evm_mine', [])
    }
  })
})

function createHashCharge(fixture: ReturnType<typeof useChargeAnvil>['fixture']) {
  return {
    server: Mppx.create({
      methods: [
        evm({
          amount: '1',
          chainId: fixture.chain.id,
          credentialTypes: ['hash'],
          currency: fixture.token,
          decimals: 6,
          getClient: () => fixture.serverClient,
          recipient: fixture.recipient.address,
        }),
      ],
      realm,
      secretKey,
    }),
    client: Mppx_client.create({
      methods: [
        evm_client({
          account: fixture.payer,
          credentialType: 'hash',
          getClient: () => fixture.payerClient,
        }),
      ],
      polyfill: false,
    }),
  }
}
