/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';

describe('MessagingService - notifyHistoryRequest', () => {
  let service: MessagingService;
  let warn: jest.SpyInstance;

  const redis = {
    smembers: jest.fn(),
    exists: jest.fn(),
    sadd: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
  };
  const deviceGroupRepo = { find: jest.fn().mockResolvedValue([]) };

  /**
   * A repository that holds nothing - which is NOT the same as one that answers `undefined`.
   *
   * `find` on a real TypeORM repository returns `[]`, and a bare `jest.fn()` returns `undefined`,
   * so every caller reading `.length` off the result threw a TypeError instead of taking the
   * empty-set branch. Isolated, the throw landed inside a caller that swallows it; alongside
   * another spec it surfaced as a failure, which is why this read as cross-file pollution and was
   * not - the fixture was simply lying about what a repository does.
   */
  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  const body = {
    groupId: 'g1',
    requesterUserId: 'reqU',
    requesterDeviceId: 'reqD',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        {
          provide: getRepositoryToken(OneTimeKeyPackage),
          useValue: emptyRepo(),
        },
        {
          provide: getRepositoryToken(DeviceGroupMembership),
          useValue: deviceGroupRepo,
        },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(MessagingService);
    // The service logs through Nest's own logger; the one case that asserts on a warning needs to
    // read it, and every other case needs it quiet.
    warn = jest
      .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => {});
  });

  it('forwards to an online member and reports it as the target', async () => {
    redis.smembers.mockResolvedValue(['ua:da']);
    redis.exists.mockResolvedValue(1);

    const res = await service.notifyHistoryRequest('reqU', body);

    expect(res).toEqual({ status: 'forwarded', target: 'ua:da' });
    expect(redis.publish).toHaveBeenCalledTimes(1);
  });

  it('relays the election and NOTHING about what is being asked for', async () => {
    // What the requester wants - a state key, a digest, a range - travels inside MLS, which this
    // service cannot read. Anything about it appearing here would be metadata the server is not
    // supposed to hold, and there is nothing for it to carry: the responder waits for the MLS frame.
    redis.smembers.mockResolvedValue(['ua:da']);
    redis.exists.mockResolvedValue(1);

    await service.notifyHistoryRequest('reqU', body);

    const published = JSON.parse(redis.publish.mock.calls[0][1] as string) as { proto: string };
    const relayed = JSON.parse(Buffer.from(published.proto, 'base64').toString());
    expect(relayed).toEqual({
      type: 'history_request',
      groupId: body.groupId,
      requesterUserId: body.requesterUserId,
      requesterDeviceId: body.requesterDeviceId,
    });
  });

  it('returns no_peer_online and publishes nothing when no member is online', async () => {
    redis.smembers.mockResolvedValue(['ua:da', 'ub:db']);
    redis.exists.mockResolvedValue(0);

    const res = await service.notifyHistoryRequest('reqU', body);

    expect(res).toEqual({ status: 'no_peer_online', excludedOnline: 0 });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('never forwards the request back to the requester device', async () => {
    redis.smembers.mockResolvedValue(['reqU:reqD']);
    redis.exists.mockResolvedValue(1);

    const res = await service.notifyHistoryRequest('reqU', body);

    expect(res).toEqual({ status: 'no_peer_online', excludedOnline: 0 });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('rejects a caller that does not match the body requester (identity spoofing)', async () => {
    redis.smembers.mockResolvedValue(['ua:da']);
    redis.exists.mockResolvedValue(1);

    await expect(service.notifyHistoryRequest('attacker', body)).rejects.toThrow(
      'requesterUserId does not match the authenticated caller'
    );
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('skips the caller check when x-user-id is absent (legacy no-op)', async () => {
    redis.smembers.mockResolvedValue(['ua:da']);
    redis.exists.mockResolvedValue(1);

    const res = await service.notifyHistoryRequest(undefined, body);

    expect(res).toEqual({ status: 'forwarded', target: 'ua:da' });
  });

  it('elects a member the requester has not heard from yet', async () => {
    redis.smembers.mockResolvedValue(['ua:da', 'ub:db']);
    redis.exists.mockResolvedValue(1);

    const res = await service.notifyHistoryRequest('reqU', { ...body, exclude: ['ua:da'] });

    expect(res).toEqual({ status: 'forwarded', target: 'ub:db' });
  });

  it('excludes a member key of the length this platform actually issues', async () => {
    /**
     * EVERY OTHER CASE IN THIS FILE USES `ua:da`, AND THAT IS HOW THE BOUND HID.
     *
     * A real member key is `userId:deviceId` where the user id is a 64-character hex digest and the
     * device id repeats it - 147 characters for a browser, 149 for the phone. The filter accepted
     * `k.length <= 128`, so it dropped every key this server has ever issued, silently, and the
     * exclusion list excluded nobody. Measured 2026-09-05 by HEAL-REVOKE-7: nine elections, the same
     * sleeping phone returned each time, and the client stopping its walk against what looked like a
     * server that ignores exclusions.
     *
     * A fixture shorter than every real value cannot fail a length bound. This one is a real value.
     */
    const user = 'f'.repeat(64);
    const phone = `${user}:tauri-${user}-mtn445lg-25sy`;
    const browser = `${user}:web-${user}-mtovytv0-9qx8`;
    expect(phone.length).toBeGreaterThan(128);
    redis.smembers.mockResolvedValue([phone, browser]);
    redis.exists.mockResolvedValue(1);

    const res = await service.notifyHistoryRequest('reqU', { ...body, exclude: [phone] });

    expect(res).toEqual({ status: 'forwarded', target: browser });
  });

  it('says how many exclusions it could not use, instead of dropping them in silence', async () => {
    redis.smembers.mockResolvedValue(['ua:da']);
    redis.exists.mockResolvedValue(1);

    await service.notifyHistoryRequest('reqU', {
      ...body,
      exclude: ['no-colon-here', 'x'.repeat(300) + ':d', 'ua:da'],
    });

    expect(warn.mock.calls.flat().join(' ')).toContain('2 exclusion(s) were unusable');
  });

  it('matches an exclusion case-insensitively, because the client keys it off its MLS identity', async () => {
    // `digestIdentity` lower-cases the user half; the membership set holds it as it was written. Two
    // spellings of one fact - and a mismatch would re-elect exactly the member just excluded.
    redis.smembers.mockResolvedValue(['UA:da']);
    redis.exists.mockResolvedValue(1);

    const res = await service.notifyHistoryRequest('reqU', { ...body, exclude: ['ua:da'] });

    expect(res).toEqual({ status: 'no_peer_online', excludedOnline: 1 });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('counts the online members it skipped - that count IS the requester termination proof', async () => {
    // `no_peer_online, excludedOnline > 0` says "every reachable member has answered you", which
    // ends a chase. `excludedOnline === 0` says "nobody was there", which is answered by a different
    // edge. Same status, two facts, told apart by evidence rather than by prose.
    redis.smembers.mockResolvedValue(['ua:da', 'ub:db']);
    redis.exists.mockResolvedValue(1);

    const res = await service.notifyHistoryRequest('reqU', {
      ...body,
      exclude: ['ua:da', 'ub:db'],
    });

    expect(res).toEqual({ status: 'no_peer_online', excludedOnline: 2 });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('does not count an OFFLINE excluded member as answered', async () => {
    // The count means "reachable and already heard from". Counting an offline member would let a
    // chase claim a proof it never had, and stop one election short of the member that could help.
    redis.smembers.mockResolvedValue(['ua:da']);
    redis.exists.mockResolvedValue(0);

    const res = await service.notifyHistoryRequest('reqU', { ...body, exclude: ['ua:da'] });

    expect(res).toEqual({ status: 'no_peer_online', excludedOnline: 0 });
  });

  it('randomizes the responder so retries rotate past a frozen-online peer', async () => {
    // Members come back in a stable order; without randomization the first (ua:da) would always be
    // picked. Forcing Math.random=0 makes the Fisher-Yates shuffle rotate a different member to the
    // front, proving the choice is no longer positionally fixed.
    redis.smembers.mockResolvedValue(['ua:da', 'ub:db', 'uc:dc']);
    redis.exists.mockResolvedValue(1);
    const randSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

    const res = await service.notifyHistoryRequest('reqU', body);

    expect(res.status).toBe('forwarded');
    expect(res.target).not.toBe('ua:da');
    randSpy.mockRestore();
  });
});
