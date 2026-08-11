import { Receipt } from 'mppx'
import { erc20Abi, type Address } from 'viem'
import { readContract } from 'viem/actions'
import { afterAll, beforeAll, expect } from 'vp/test'

import { startAnvil, type AnvilFixture } from './anvil.js'

export const realm = 'api.example.com'
export const secretKey = 'test-secret-key'

export function useChargeAnvil() {
  let fixture: AnvilFixture

  beforeAll(async () => {
    fixture = await startAnvil()
  })

  afterAll(async () => {
    await fixture?.stop()
  })

  return {
    get fixture() {
      return fixture
    },
    anvilRequest(method: string, params: readonly unknown[]) {
      return fixture.publicClient.request({ method, params } as never)
    },
    balanceOf(token: Address, owner: Address) {
      return readContract(fixture.publicClient, {
        abi: erc20Abi,
        address: token,
        args: [owner],
        functionName: 'balanceOf',
      })
    },
    expires() {
      return new Date(Date.now() + 60_000).toISOString()
    },
    async settle(parameters: { client: any; server: any }): Promise<{
      authorization: string
      receipt: Receipt.Receipt
    }> {
      const challenge = await parameters.server.charge({ expires: this.expires() })(
        new Request('https://api.example.com/resource'),
      )
      expect(challenge.status).toBe(402)
      if (challenge.status !== 402) throw new Error('Expected an EVM charge challenge.')

      const authorization = await parameters.client.createCredential(challenge.challenge)
      const result = await parameters.server.charge({ expires: this.expires() })(
        new Request('https://api.example.com/resource', {
          headers: { Authorization: authorization },
        }),
      )

      expect(result.status).toBe(200)
      if (result.status !== 200) throw new Error('Expected EVM charge settlement.')

      const response = result.withReceipt(new Response('ok'))
      const receipt = Receipt.fromResponse(response)
      expect(receipt.challengeId).toBeDefined()

      return { authorization, receipt }
    },
  }
}
