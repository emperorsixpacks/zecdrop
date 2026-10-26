// The real NearApi: the panel's calls, answered by the operator. The wire shapes stop here;
// the panel sees its own types (model.ts).

import { getNearStatus, getNearTokens, postNearDryQuote, postNearLiveQuote, postNearPreview } from "@/api/operator/client";

import type { NearApi } from "./model";

export const operatorNearApi: NearApi = {
  tokens: (signal) => getNearTokens(signal),
  preview: async ({ tokenId, fundingRequired }, signal) => {
    const p = await postNearPreview({ originAssetId: tokenId, amountZat: fundingRequired }, signal);
    return { token: p.token, amountIn: p.amountIn, amountOut: p.amountOut };
  },
  dryQuote: async ({ campaignId, tokenId, refundTo }, signal) => {
    const q = await postNearDryQuote(campaignId, { originAssetId: tokenId, refundTo }, signal);
    return { token: q.token, amountIn: q.amountIn, amountOut: q.amountOut };
  },
  liveQuote: async ({ campaignId }, signal) => {
    const q = await postNearLiveQuote(campaignId, signal);
    return {
      token: q.token,
      amountIn: q.amountIn,
      amountOut: q.amountOut,
      depositAddress: q.depositAddress,
      depositMemo: q.depositMemo,
      deadline: q.deadline,
      refundTo: q.refundTo,
    };
  },
  status: async ({ campaignId }, signal) => {
    const s = await getNearStatus(campaignId, signal);
    return { status: s.status, step: s.step, depositAddress: s.depositAddress, expired: s.expired, validUntil: s.validUntil, zecTxids: s.zecTxids };
  },
};
