vi.mock('@mtcute/node', () => ({
  TelegramClient: vi.fn(),
}));
vi.mock('@mtcute/core', () => ({
  InputMedia: {
    auto: vi.fn(),
  },
}));
vi.mock('@mtcute/markdown-parser', () => ({
  md: vi.fn((text) => text),
}));
vi.mock('@mtcute/html-parser', () => ({
  html: vi.fn((text) => text),
}));

import { describe, expect, it, vi } from 'vitest';

import TelegramClient, { buildIterDialogsParams, serializeDialog } from '../telegram-client.js';

function makeDialog(peer, extra = {}) {
  return {
    peer: { type: 'user', displayName: peer.title, ...peer },
    unreadCount: extra.unreadCount ?? 0,
    unreadMentionsCount: 0,
    isUnread: (extra.unreadCount ?? 0) > 0,
    isPinned: extra.isPinned ?? false,
    isArchived: extra.isArchived ?? false,
    isMuted: null,
    lastMessage: extra.date ? { date: new Date(extra.date) } : null,
  };
}

// A fake mtcute client whose iterDialogs mimics the archived/main split, so the
// tests prove which params tgcli passes rather than mtcute's own filtering.
function makeClient(dialogs) {
  const calls = [];
  return {
    calls,
    client: {
      calls,
      iterDialogs: async function* (params) {
        calls.push(params);
        for (const d of dialogs) {
          if (params.archived === 'exclude' && d.isArchived) continue;
          if (params.archived === 'only' && !d.isArchived) continue;
          yield d;
        }
      },
      call: vi.fn(async () => ({ chats: [], users: [{ id: 99, firstName: 'Public', lastName: 'Peer' }] })),
    },
  };
}

function makeTc(dialogs) {
  const { client, calls } = makeClient(dialogs);
  const tc = Object.create(TelegramClient.prototype);
  tc.client = client;
  tc.ensureLogin = vi.fn().mockResolvedValue(true);
  return { tc, calls };
}

const DIALOGS = [
  makeDialog({ id: 1, title: 'Pinned Friend' }, { isPinned: true, date: '2026-10-28T20:00:00Z' }),
  makeDialog({ id: 116739434, title: 'Hossein Irani' }, { isArchived: true, unreadCount: 1, date: '2026-10-28T23:35:00Z' }),
  makeDialog({ id: 2, title: 'Group' }, { unreadCount: 6, date: '2026-10-28T22:59:00Z' }),
  makeDialog({ id: 1414535448, title: 'reza' }, { isArchived: true, unreadCount: 2, date: '2026-10-26T21:23:00Z' }),
];

describe('buildIterDialogsParams', () => {
  it('always passes the archived mode explicitly (mtcute defaults to exclude)', () => {
    expect(buildIterDialogsParams()).toEqual({ archived: 'exclude' });
    expect(buildIterDialogsParams({ archived: 'include' })).toEqual({ archived: 'keep' });
    expect(buildIterDialogsParams({ archived: 'only' })).toEqual({ archived: 'only' });
  });

  it('turns a numeric folder into an id and keeps a title as a string', () => {
    expect(buildIterDialogsParams({ folder: '3' })).toEqual({ archived: 'exclude', folder: 3 });
    expect(buildIterDialogsParams({ folder: 'خانواده' })).toEqual({ archived: 'exclude', folder: 'خانواده' });
  });

  it('rejects an unknown archived mode', () => {
    expect(() => buildIterDialogsParams({ archived: 'keep' })).toThrow(/archived must be one of/);
  });
});

describe('serializeDialog', () => {
  it('reports archive, pin, unread state and the last message date', () => {
    expect(serializeDialog(DIALOGS[1])).toMatchObject({
      id: '116739434',
      title: 'Hossein Irani',
      unreadCount: 1,
      isArchived: true,
      isPinned: false,
      lastMessageDate: '2026-10-28T23:35:00.000Z',
    });
  });
});

describe('listDialogs', () => {
  it('lists the main list by default and leaves archived chats out', async () => {
    const { tc, calls } = makeTc(DIALOGS);
    const result = await tc.listDialogs(10);
    expect(calls[0]).toEqual({ archived: 'exclude' });
    expect(result.map((d) => d.id)).toEqual(['1', '2']);
  });

  it('includes archived chats with their unread counts when asked', async () => {
    const { tc, calls } = makeTc(DIALOGS);
    const result = await tc.listDialogs(10, { archived: 'include' });
    expect(calls[0]).toEqual({ archived: 'keep' });
    expect(result.find((d) => d.id === '1414535448')).toMatchObject({ isArchived: true, unreadCount: 2 });
  });

  it('drops main-list pinned chats that Telegram returns for the Archive', async () => {
    const leaky = [
      makeDialog({ id: 1, title: 'Pinned Friend' }, { isPinned: true }),
      makeDialog({ id: 5, title: 'Archived' }, { isArchived: true }),
    ];
    const tc = Object.create(TelegramClient.prototype);
    tc.ensureLogin = vi.fn().mockResolvedValue(true);
    tc.client = { iterDialogs: async function* () { yield* leaky; } };
    const result = await tc.listDialogs(10, { archived: 'only' });
    expect(result.map((d) => d.id)).toEqual(['5']);
  });

  it('passes a folder through to iterDialogs', async () => {
    const { tc, calls } = makeTc(DIALOGS);
    await tc.listDialogs(10, { folder: 'خصوصی' });
    expect(calls[0]).toEqual({ archived: 'exclude', folder: 'خصوصی' });
  });
});

describe('searchDialogs', () => {
  it('matches your own dialogs, archive included, with unread counts', async () => {
    const { tc } = makeTc(DIALOGS);
    const result = await tc.searchDialogs('hossein', 10);
    expect(tc.client.call).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: '116739434', isArchived: true, unreadCount: 1 });
  });

  it('uses contacts.search only with global', async () => {
    const { tc } = makeTc(DIALOGS);
    tc.ensureLogin = vi.fn().mockResolvedValue(true);
    const result = await tc.searchDialogs('peer', 10, { global: true });
    expect(tc.client.call).toHaveBeenCalledWith(expect.objectContaining({ _: 'contacts.search', q: 'peer' }));
    expect(result[0]).toMatchObject({ id: '99', title: 'Public Peer' });
  });
});
