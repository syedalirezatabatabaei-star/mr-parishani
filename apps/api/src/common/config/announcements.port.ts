/**
 * Port to the config module's announcements (owner 1405/08/10): those in force now for one
 * account, by its kind and roles, for the notification module's bell.
 */
export interface LiveAnnouncement {
  readonly announcementKey: string;
  readonly title: string;
  readonly body: string;
  readonly urgent: boolean;
  readonly startsAt: Date;
}

export interface AnnouncementsPort {
  liveFor(
    viewer: { kind: 'patient' | 'staff' | 'center'; roles: readonly string[] },
    now?: Date,
  ): Promise<LiveAnnouncement[]>;
}

export const ANNOUNCEMENTS = Symbol('ANNOUNCEMENTS');
