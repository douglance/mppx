import { Mppx as Mppx_client, evm as evm_client } from 'mppx/client'
import { Mppx, evm } from 'mppx/server'
import { describe, expect, test } from 'vp/test'
import { realm, secretKey, useChargeAnvil } from '~test/evm/charge.js'

describe('EVM EIP-3009 authorization charge verifier', () => {
  const anvil = useChargeAnvil()

  test('settles transferWithAuthorization and rejects replay', async () => {
    const { fixture } = anvil
    const before = await anvil.balanceOf(fixture.authorizationToken, fixture.recipient.address)
    const authorizationDomain = {
      chainId: fixture.chain.id,
      name: 'Mock EIP3009 USDC',
      verifyingContract: fixture.authorizationToken,
      version: '1',
    } as const
    const server = Mppx.create({
      methods: [
        evm({
          account: fixture.deployer,
          amount: '1',
          authorizationDomain,
          chainId: fixture.chain.id,
          credentialTypes: ['authorization'],
          currency: fixture.authorizationToken,
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
          authorizationDomain,
          credentialType: 'authorization',
          getClient: () => fixture.payerClient,
        }),
      ],
      polyfill: false,
    })

    const { authorization, receipt } = await anvil.settle({ client, server })

    expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)
    await expect(
      anvil.balanceOf(fixture.authorizationToken, fixture.recipient.address),
    ).resolves.toBe(before + 1_000_000n)

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
})
