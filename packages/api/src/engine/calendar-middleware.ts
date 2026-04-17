import { google } from 'googleapis';
import type { Middleware } from './pipeline.js';
import type { ProfileStore } from '@jarvis/shared';

/**
 * Calendar Awareness Middleware (OAuth version)
 *
 * Checks if the user's profile has a `google_refresh_token` in `preferences`.
 * If true, authenticates and fetches the day's upcoming events.
 * If false, quietly omits the calendar context.
 */
export function calendarMiddleware(profileStore: ProfileStore): Middleware {
  return async (ctx, next) => {
    try {
      const profile = await profileStore.getProfile('default');
      const refreshToken = profile?.preferences?.google_refresh_token;

      let scheduleText = '';
      const now = new Date();
      const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      if (refreshToken && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        // Authentic Google Calendar fetch
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({ refresh_token: refreshToken });

        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        
        // End of today
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        const res = await calendar.events.list({
          calendarId: 'primary',
          timeMin: now.toISOString(),
          timeMax: endOfDay.toISOString(),
          maxResults: 10,
          singleEvents: true,
          orderBy: 'startTime',
        });

        const events = res.data.items;
        if (events && events.length > 0) {
          scheduleText = `Upcoming Events Today:\n`;
          for (const ev of events) {
             const start = ev.start?.dateTime || ev.start?.date;
             const timeStr = start ? new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit'}) : 'All Day';
             scheduleText += `- [${timeStr}] ${ev.summary}\n`;
          }
        } else {
          scheduleText = `No upcoming events for the rest of today.\n`;
        }
      } else {
         // No OAuth setup, warn internally but don't crash
         scheduleText = `Calendar integration pending. OAuth tokens not configured.\n`;
      }

      const injection = {
        role: 'system' as const,
        content: `[SYSTEM - Context] You are aware of the user's local time and calendar.\nLocal Time: ${timeString}\n\n${scheduleText}`,
      };

      const sysIndex = ctx.messages.findIndex((m) => m.role === 'system');
      ctx.messages.splice(sysIndex + 1, 0, injection);

    } catch (err) {
      console.warn(`[calendar] recall failed: ${err}`);
    }

    await next();
  };
}
