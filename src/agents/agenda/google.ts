import { google } from 'googleapis';
import type { Config } from '../../config.js';

export interface CalendarService {
  busy(from: Date, to: Date): Promise<{ start: Date; end: Date }[]>;
  createMeeting(m: { start: Date; end: Date; email: string; name: string }): Promise<{ eventId: string; meetLink: string }>;
}

export interface MailService {
  send(m: { to: string; subject: string; text: string }): Promise<void>;
}

export function createGoogleServices(cfg: NonNullable<Config['google']>): { calendar: CalendarService; mail: MailService } {
  const auth = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
  auth.setCredentials({ refresh_token: cfg.refreshToken });
  const cal = google.calendar({ version: 'v3', auth });
  const gmail = google.gmail({ version: 'v1', auth });

  const calendar: CalendarService = {
    async busy(from, to) {
      const r = await cal.freebusy.query({
        requestBody: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: cfg.calendarId }] },
      });
      const busy = r.data.calendars?.[cfg.calendarId]?.busy ?? [];
      return busy.map((b) => ({ start: new Date(b.start!), end: new Date(b.end!) }));
    },
    async createMeeting({ start, end, email, name }) {
      const r = await cal.events.insert({
        calendarId: cfg.calendarId,
        conferenceDataVersion: 1,
        sendUpdates: 'all',
        requestBody: {
          summary: `Reunión con ${name}`,
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
          attendees: [{ email }],
          conferenceData: {
            createRequest: { requestId: `meet-${start.getTime()}-${Math.random().toString(36).slice(2)}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
          },
        },
      });
      return { eventId: r.data.id ?? '', meetLink: r.data.hangoutLink ?? '' };
    },
  };

  const mail: MailService = {
    async send({ to, subject, text }) {
      const raw = [
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(text, 'utf8').toString('base64'),
      ].join('\r\n');
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(raw).toString('base64url') } });
    },
  };

  return { calendar, mail };
}
