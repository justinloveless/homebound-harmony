import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Schedule from './Schedule';
import type { Workspace } from '@/types/models';

const { setScheduleMock, workspaceFixture } = vi.hoisted(() => ({
  setScheduleMock: vi.fn(),
  workspaceFixture: {
    version: 1,
    worker: {
      name: 'Care Worker',
      homeAddress: '100 Home St',
      workingHours: { startTime: '08:00', endTime: '17:00' },
      daysOff: ['saturday', 'sunday'],
      breaks: [],
      schedulingStrategy: 'spread',
    },
    clients: [
      {
        id: 'client-1',
        name: 'Apple Client',
        address: '1 Apple Way',
        visitDurationMinutes: 60,
        visitsPerPeriod: 1,
        period: 'week',
        priority: 'medium',
        timeWindows: [
          { day: 'monday', startTime: '09:00', endTime: '12:00' },
          { day: 'tuesday', startTime: '09:00', endTime: '12:00' },
        ],
        notes: '',
      },
    ],
    travelTimes: {
      'client-1|home': 15,
    },
    lastSchedule: {
      weekStartDate: '2026-05-04',
      totalTravelMinutes: 30,
      totalTimeAwayMinutes: 90,
      days: [
        {
          day: 'monday',
          date: '2026-05-04',
          visits: [
            {
              clientId: 'client-1',
              startTime: '09:00',
              endTime: '10:00',
              travelTimeFromPrev: 15,
            },
          ],
          totalTravelMinutes: 30,
          leaveHomeTime: '08:45',
          arriveHomeTime: '10:15',
        },
      ],
    },
    savedSchedules: [],
  } satisfies Workspace,
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}));

vi.mock('@/components/RouteMap', () => ({
  default: () => <div data-testid="route-map" />,
}));

vi.mock('@/lib/google-maps', () => ({
  getTimeDependentTravelTimes: vi.fn(async (addresses: string[]) => ({
    durationInTraffic: addresses.slice(1).map(() => 15),
    distanceMiles: addresses.slice(1).map(() => 1),
  })),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    workspace: workspaceFixture,
    setSchedule: setScheduleMock,
    saveSchedule: vi.fn(),
    loadSavedSchedule: vi.fn(),
    deleteSavedSchedule: vi.fn(),
    renameSavedSchedule: vi.fn(),
    updateClient: vi.fn(),
  }),
}));

describe('Schedule', () => {
  beforeEach(() => {
    setScheduleMock.mockReset();
  });

  it('copies the selected daily schedule to another day on mobile', async () => {
    // Arrange
    render(<Schedule />);

    await screen.findByText('Mon Route');

    // Act
    fireEvent.click(screen.getByRole('button', { name: /copy day/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy to Tue' }));

    // Assert
    await waitFor(() => {
      expect(setScheduleMock).toHaveBeenCalled();
    });

    const copiedSchedule = setScheduleMock.mock.calls.at(-1)?.[0] as Workspace['lastSchedule'];
    const copiedDay = copiedSchedule?.days.find(day => day.day === 'tuesday');

    expect(copiedDay?.visits).toHaveLength(1);
    expect(copiedDay?.visits[0].clientId).toBe('client-1');
  });
});
