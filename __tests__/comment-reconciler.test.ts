/**
 * Comment reconciliation — ad copies of a boosted post, and repeat-send guards.
 *
 * Comments left on an ad carry the ad's own media id, so the sweep has to look
 * at those media too or a webhook Meta never delivers is lost for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockQueue, mockGetRecentMediaComments } = vi.hoisted(
  () => ({
    mockPrisma: {
      $queryRaw: vi.fn(),
      automation: { findMany: vi.fn() },
      dmLog: { findMany: vi.fn() },
      operationalEvent: { create: vi.fn() },
    },
    mockQueue: { add: vi.fn(), getJobs: vi.fn() },
    mockGetRecentMediaComments: vi.fn(),
  })
);

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => mockQueue }));
vi.mock("@/lib/instagram/provider", () => ({
  MetaApiError: class MetaApiError extends Error {},
  createInstagramContext: vi.fn().mockResolvedValue({ provider: "META" }),
  getRecentMediaComments: mockGetRecentMediaComments,
  getUserMedia: vi.fn(),
}));

import {
  adMediaFor,
  commentIdsInQueue,
  reconcileComments,
} from "../lib/polling/comment-reconciler";

const POST = "18023946917554990";
const AD = "17899788633163100";

describe("adMediaFor", () => {
  beforeEach(() => {
    mockPrisma.$queryRaw.mockReset();
  });

  it("returns the ad media ids seen for the post", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("never returns the post itself, so it is not swept twice", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }, { mediaId: POST }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("drops rows without a media id", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: null }, { mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("returns nothing when the post was never boosted", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });

  it("swallows a query failure, leaving the post itself still swept", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("connection lost"));
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });
});

describe("commentIdsInQueue", () => {
  it("collects comment ids from pending jobs and ignores jobs without one", async () => {
    const queue = {
      getJobs: vi.fn().mockResolvedValue([
        { data: { commentId: "c1" } },
        { data: { userId: "u1", payload: "reveal:a" } },
        undefined,
        { data: { commentId: "c2" } },
      ]),
    };

    await expect(commentIdsInQueue(queue)).resolves.toEqual(
      new Set(["c1", "c2"])
    );
    expect(queue.getJobs).toHaveBeenCalledWith([
      "waiting",
      "delayed",
      "active",
      "prioritized",
    ]);
  });
});

describe("reconcileComments — repeat-send guards", () => {
  const ACCOUNT_IG_ID = "17841400919506085";

  function comment(id: string) {
    return {
      id,
      text: "App",
      from: { id: `user_${id}`, username: `user_${id}` },
      timestamp: "2026-09-17T06:17:00Z",
      replies: { data: [] },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "auto_1",
        name: "Referral",
        postId: POST,
        matchAnyPost: false,
        matchAnyWord: false,
        keywords: ["app"],
        wholeWordMatch: false,
        publicReplyEnabled: false,
        workspaceId: "ws_1",
        instagramAccount: {
          id: "acct_row_1",
          instagramId: ACCOUNT_IG_ID,
          username: "me",
          accessToken: "enc",
          provider: "META",
          workspaceId: "ws_1",
          zernioAccountId: null,
        },
      },
    ]);
    mockGetRecentMediaComments.mockResolvedValue([
      comment("fresh"),
      comment("exhausted"),
      comment("queued"),
    ]);
    // First lookup: fully handled comments. Second: comments out of retries.
    mockPrisma.dmLog.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ commentId: "exhausted" }]);
    mockQueue.getJobs.mockResolvedValue([{ data: { commentId: "queued" } }]);
  });

  it("queues only comments with no pending job and retries left", async () => {
    await reconcileComments();

    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockQueue.add).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({ commentId: "fresh" })
    );
    expect(mockPrisma.dmLog.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "FAILED",
          attempts: { gte: 3 },
        }),
      })
    );
  });
});
