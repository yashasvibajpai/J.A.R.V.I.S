export interface Reminder {
  id: string;
  description: string;
  triggerTime?: string;
  triggerContext?: string;
  snoozedUntil?: string;
  completed: boolean;
  createdAt: string;
}

export interface ReminderStore {
  createReminder(reminder: Omit<Reminder, 'id' | 'createdAt'>): Promise<Reminder>;
  updateReminder(id: string, updates: Partial<Reminder>): Promise<Reminder>;
  deleteReminder(id: string): Promise<boolean>;
  getPendingReminders(): Promise<Reminder[]>;
}
