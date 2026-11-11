import type { CommunicationSize } from './communication-size.js';

export interface TicketOwner {
  username: string;
  email: string | null;
}

export interface ImprovementTicket {
  id: string;
  customId: string | null;
  name: string;
  url: string;
  owners: TicketOwner[];
}

export interface ClickUpContext {
  task: {
    id: string;
    customId: string | null;
    name: string;
    url: string;
    description: string;
    communicationSize: CommunicationSize | null;
  };
  subtasks: {
    id: string;
    customId: string | null;
    name: string;
    description: string;
    taskType: string | null;
  }[];
  comments: { taskId: string; author: string; date: string; text: string }[];
  improvementTickets: ImprovementTicket[];
  imageUrls: string[];
  warnings: string[];
}
