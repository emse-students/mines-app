import { describe, it, expect } from 'vitest';
import { isChannelEventFrame, isHeartbeatFrame } from './channelEventTypes';

/**
 * The routing table both socket clients ask, and the four frames it used to drop.
 *
 * Every type asserted below is one the social service really publishes through
 * `publishChannelEvent`; the `workspace.*` four were published, forwarded by the gateway, delivered
 * to the socket and discarded by a `startsWith('channel.')` written before they existed. This file
 * is what makes adding a family to the server without adding it here a failing test rather than a
 * feature that quietly does nothing.
 */
describe('isChannelEventFrame', () => {
  it('routes every channel frame the server publishes', () => {
    for (const type of [
      'channel.message.created',
      'channel.message.deleted',
      'channel.member.joined',
      'channel.member.kicked',
      'channel.member.removed',
      'channel.updated',
      'channel.deleted',
      'channel.pin',
      'channel.poll.vote',
      'channel.typing',
    ]) {
      expect(isChannelEventFrame(type)).toBe(true);
    }
  });

  /** THE FOUR THAT WERE DROPPED. COMM-20 measured the last one on production on 2026-08-20. */
  it('routes every workspace frame the server publishes', () => {
    for (const type of [
      'workspace.updated',
      'workspace.deleted',
      'workspace.role.changed',
      'workspace.role.permissions',
    ]) {
      expect(isChannelEventFrame(type)).toBe(true);
    }
  });

  /** Frames owned by other branches of the socket handler must NOT be swallowed by this one. */
  it('leaves the socket layer its own frames', () => {
    for (const type of [
      'typing',
      'device_revoked',
      'welcome_request',
      'history_request',
      'epoch_rejected',
      'ping',
      'pong',
      // The frame this table used to route to a handler with no branch for it. Its only sender was
      // a Kafka consumer nothing ever fed, both of which went on 2026-08-31.
      'post_created',
      '',
    ]) {
      expect(isChannelEventFrame(type)).toBe(false);
    }
  });

  /** A prefix is a family, not a substring: a type must START with one to belong to it. */
  it('does not match a family named in the middle of a type', () => {
    expect(isChannelEventFrame('mls.channel.updated')).toBe(false);
    expect(isChannelEventFrame('channel')).toBe(false);
  });
});

/**
 * The gateway answers every 8-second heartbeat with `{"type":"pong"}`, so this predicate runs on
 * the most frequent frame either client ever sees. `WebMlsService` compared inline and returned;
 * `TauriMlsService` had no such branch and printed `frame type "pong" reached no handler - the
 * server is sending something this client does not route` on every one of them: thirteen in ninety
 * seconds on a Mi 9T on 2026-09-06, for ever, on every mobile client, accusing the server over the
 * one frame it is required to send.
 */
describe('isHeartbeatFrame', () => {
  it('claims the keepalives, which belong to no handler', () => {
    expect(isHeartbeatFrame('pong')).toBe(true);
    expect(isHeartbeatFrame('ping')).toBe(true);
  });

  it('claims nothing else - a heartbeat that swallowed a real frame would be the worse defect', () => {
    for (const type of [
      '',
      'welcome_request',
      'device_revoked',
      'typing',
      'channel.message.created',
      'workspace.updated',
      'pinged',
      'pong.extra',
    ]) {
      expect(isHeartbeatFrame(type)).toBe(false);
    }
  });

  it('is disjoint from the channel-event table, so neither can shadow the other', () => {
    for (const type of ['ping', 'pong']) {
      expect(isChannelEventFrame(type)).toBe(false);
    }
  });
});
