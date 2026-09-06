/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DevicesController } from './devices.controller';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * THE SERVER PROMISES REUSE, AND THIS IS WHERE IT MAKES THE PROMISE.
 *
 * Once a device's one-time pool is empty, `resolveKeyPackagePayloadForDevice` returns the static
 * `key_package` row - the same bytes, to every caller, until the device reconnects and replaces it.
 * That is deliberate: without it a device whose pool ran dry could never be added to a group again.
 *
 * MLS makes the opposite promise about an ordinary KeyPackage: `into_group` deletes its private
 * bundle at the first Welcome built on it. The two promises are only compatible because the client
 * mints this row with the `last_resort` extension (`mintKeyPackages`, and
 * `frontend/mls-core/tests/last_resort_key_package.rs` for what happens when it does not). These
 * tests pin the server half so the pair cannot drift apart silently: if this endpoint ever starts
 * consuming the static row, the client's last-resort marking becomes pointless, and if it keeps
 * serving it, the marking is load-bearing.
 *
 * Measured cost of the mismatch, Mi 9T, 2026-09-06: ten groups re-added in one burst, one join, and
 * nineteen `NoMatchingKeyPackage` refusals with no exit until the next connection.
 */
describe('DevicesController - the static KeyPackage row once the pool is empty', () => {
  let controller: DevicesController;
  let keyPackageRepo: { findOne: jest.Mock; find: jest.Mock };
  let warn: jest.SpyInstance;

  /** A pool that is empty: the locked SELECT finds nothing, so nothing is deleted. */
  const emptyPool = {
    transaction: jest.fn(async (fn: (m: unknown) => unknown) =>
      fn({
        getRepository: () => ({
          createQueryBuilder: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  setLock: () => ({
                    setOnLocked: () => ({ getOne: async () => null }),
                  }),
                }),
              }),
            }),
          }),
        }),
        delete: jest.fn(),
      })
    ),
  };

  beforeEach(async () => {
    keyPackageRepo = {
      findOne: jest.fn().mockResolvedValue({
        userId: 'u1',
        deviceId: 'd1',
        keyPackage: 'THE-STATIC-ROW',
        deviceName: 'Mi 9T',
      }),
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DevicesController],
      providers: [
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: {} },
        { provide: getRepositoryToken(GroupMember), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(Group), useValue: { find: jest.fn(() => []) } },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(PushToken), useValue: {} },
        {
          provide: getRepositoryToken(RevokedDevice),
          useValue: { findOne: jest.fn().mockResolvedValue(null), find: jest.fn(() => []) },
        },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: DataSource, useValue: emptyPool },
        { provide: MessagingService, useValue: {} },
      ],
    })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(DevicesController);
    warn = jest.spyOn(controller['logger'], 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  it('serves the SAME row to every caller, which is what the client must survive', async () => {
    const first = await controller.getDeviceKeyPackage('u1', 'd1');
    const second = await controller.getDeviceKeyPackage('u1', 'd1');
    const third = await controller.getDeviceKeyPackage('u1', 'd1');

    expect(first.keyPackage).toBe('THE-STATIC-ROW');
    expect(second.keyPackage).toBe('THE-STATIC-ROW');
    expect(third.keyPackage).toBe('THE-STATIC-ROW');
  });

  it('says the pool is empty, because nothing else can see that from outside', async () => {
    await controller.getDeviceKeyPackage('u1', 'd1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('one-time pool EMPTY'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('u1/d1'));
  });
});
