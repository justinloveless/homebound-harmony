import { useState, useCallback, useRef, useEffect } from 'react';
import type { DayOfWeek, ScheduledVisit, DaySchedule, Client, WorkerProfile, TravelTimeMatrix, TimeWindow } from '@/types/models';
import { DAYS_OF_WEEK } from '@/types/models';

export interface DragInfo {
  clientId: string;
  sourceDay: DayOfWeek;
  sourceIndex: number;
  durationMinutes: number;
}

export interface DragPosition {
  day: DayOfWeek;
  minuteOfDay: number; // snapped to 15-min
}

export interface DropResult {
  /** The day the visit was dropped on */
  day: DayOfWeek;
  /** Start time in minutes from midnight, snapped to 15-min block */
  startMinute: number;
  /** The dragged visit info */
  dragInfo: DragInfo;
}

interface UseCalendarDragOptions {
  /** Ref to the scrollable calendar container */
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  /** Map of day → column DOM element ref */
  dayColumnRefs: React.RefObject<Map<DayOfWeek, HTMLDivElement>>;
  /** Pixels per minute */
  minHeight: number;
  /** Minute offset from midnight (the first visible minute in the zoomed calendar) */
  startMinuteOffset?: number;
  /** Worker profile for work hours / breaks */
  worker: WorkerProfile;
  /** All clients */
  clients: Client[];
  /** Current schedule */
  schedule: { days: DaySchedule[] } | null;
  /** Callback when a valid drop occurs */
  onDrop: (result: DropResult) => void;
}

export function useCalendarDrag(options: UseCalendarDragOptions) {
  const { scrollContainerRef, dayColumnRefs, minHeight, worker, clients, schedule, onDrop, startMinuteOffset = 0 } = options;

  const [dragInfo, setDragInfo] = useState<DragInfo | null>(null);
  const [dragPosition, setDragPosition] = useState<DragPosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Ghost element position (viewport coords)
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);

  // Refs to avoid stale closures
  const dragInfoRef = useRef<DragInfo | null>(null);
  const dragPositionRef = useRef<DragPosition | null>(null);
  const lastLoggedDragPositionRef = useRef<string | null>(null);
  const isDraggingRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const hasMovedRef = useRef(false);

  const DRAG_THRESHOLD = 8; // px before drag starts
  const justFinishedDragRef = useRef(false);

  const getDayAndMinute = useCallback((clientX: number, clientY: number): DragPosition | null => {
    const columns = dayColumnRefs.current;
    if (!columns) return null;

    for (const [day, el] of columns.entries()) {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) {
        // rect.top already accounts for scroll position since the column
        // is a child of the scroll container with full height
        const yInColumn = clientY - rect.top;
        const rawMinutes = yInColumn / minHeight;
        const snapped = Math.round(rawMinutes / 15) * 15;
        const clamped = Math.max(0, Math.min(snapped, 24 * 60 - 15));
        return { day, minuteOfDay: clamped };
      }
    }
    return null;
  }, [dayColumnRefs, scrollContainerRef, minHeight]);

  const handlePointerDown = useCallback((
    clientX: number,
    clientY: number,
    info: DragInfo,
  ) => {
    console.debug('[calendar-drag] pointer down', { clientX, clientY, info });
    dragInfoRef.current = info;
    startPosRef.current = { x: clientX, y: clientY };
    hasMovedRef.current = false;
    // Don't set isDragging yet — wait for threshold
  }, []);

  const handlePointerMove = useCallback((clientX: number, clientY: number) => {
    if (!dragInfoRef.current || !startPosRef.current) return;

    if (!hasMovedRef.current) {
      const dx = clientX - startPosRef.current.x;
      const dy = clientY - startPosRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      hasMovedRef.current = true;
      isDraggingRef.current = true;
      console.debug('[calendar-drag] drag started', {
        dragInfo: dragInfoRef.current,
        start: startPosRef.current,
        current: { x: clientX, y: clientY },
      });
      setIsDragging(true);
      setDragInfo(dragInfoRef.current);
    }

    if (!isDraggingRef.current) return;

    setGhostPos({ x: clientX, y: clientY });

    const pos = getDayAndMinute(clientX, clientY);
    dragPositionRef.current = pos;
    const logKey = pos ? `${pos.day}-${pos.minuteOfDay}` : 'outside-calendar';
    if (lastLoggedDragPositionRef.current !== logKey) {
      lastLoggedDragPositionRef.current = logKey;
      console.debug('[calendar-drag] drag position changed', { clientX, clientY, pos });
    }
    setDragPosition(pos);
  }, [getDayAndMinute]);

  const handlePointerUp = useCallback(() => {
    const wasDragging = isDraggingRef.current && hasMovedRef.current;
    const finalPosition = dragPositionRef.current;

    console.debug('[calendar-drag] pointer up', {
      wasDragging,
      dragInfo: dragInfoRef.current,
      finalPosition,
      hasMoved: hasMovedRef.current,
      isDragging: isDraggingRef.current,
    });

    if (wasDragging && dragInfoRef.current) {
      // Use ref to get the latest position (avoids stale closure)
      const pos = finalPosition;
      if (pos) {
        console.debug('[calendar-drag] dispatching drop', {
          day: pos.day,
          startMinute: pos.minuteOfDay,
          dragInfo: dragInfoRef.current,
        });
        onDrop({
          day: pos.day,
          startMinute: pos.minuteOfDay,
          dragInfo: dragInfoRef.current,
        });
      } else {
        console.debug('[calendar-drag] drop skipped: no final calendar position');
      }
    }

    // If we actually dragged, suppress the upcoming click event
    if (wasDragging) {
      justFinishedDragRef.current = true;
      setTimeout(() => { justFinishedDragRef.current = false; }, 50);
    }

    // Reset
    dragInfoRef.current = null;
    dragPositionRef.current = null;
    lastLoggedDragPositionRef.current = null;
    startPosRef.current = null;
    hasMovedRef.current = false;
    isDraggingRef.current = false;
    setIsDragging(false);
    setDragInfo(null);
    setDragPosition(null);
    setGhostPos(null);
  }, [onDrop]);

  // Attach global listeners when dragging
  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      handlePointerMove(e.clientX, e.clientY);
    };
    const onMouseUp = (e: MouseEvent) => {
      e.preventDefault();
      handlePointerUp();
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        handlePointerMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      handlePointerUp();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isDragging, handlePointerMove, handlePointerUp]);

  // Get available time windows for the dragged client
  const dragClientWindows = (() => {
    if (!dragInfo) return [];
    const client = clients.find(c => c.id === dragInfo.clientId);
    if (!client) return [];
    return client.timeWindows;
  })();

  // Check if current drag position is valid
  const isValidDropPosition = (() => {
    if (!dragPosition || !dragInfo) return false;
    const client = clients.find(c => c.id === dragInfo.clientId);
    if (!client) return false;

    // Check if client has a time window on this day
    const tw = client.timeWindows.find(w => w.day === dragPosition.day);
    if (!tw) return false;

    const twStart = timeToMin(tw.startTime);
    const twEnd = timeToMin(tw.endTime);
    const dropStart = dragPosition.minuteOfDay;
    const dropEnd = dropStart + dragInfo.durationMinutes;

    // Must be within time window
    if (dropStart < twStart || dropEnd > twEnd) return false;

    // Must be within work hours
    const whStart = timeToMin(worker.workingHours.startTime);
    const whEnd = timeToMin(worker.workingHours.endTime);
    if (dropStart < whStart || dropEnd > whEnd) return false;

    // Must not overlap with breaks
    for (const b of worker.breaks) {
      const bs = timeToMin(b.startTime);
      const be = timeToMin(b.endTime);
      if (dropStart < be && dropEnd > bs) return false;
    }

    return true;
  })();

  // Handlers for visit blocks
  const createDragHandlers = (info: DragInfo) => ({
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handlePointerDown(e.clientX, e.clientY, info);

      // Attach temporary mouse move/up for threshold detection
      const onMove = (me: MouseEvent) => handlePointerMove(me.clientX, me.clientY);
      const onUp = () => {
        handlePointerUp();
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    onTouchStart: (e: React.TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      handlePointerDown(touch.clientX, touch.clientY, info);

      // For touch, we need a long-press to initiate drag
      const longPressTimer = setTimeout(() => {
        hasMovedRef.current = true;
        isDraggingRef.current = true;
        setIsDragging(true);
        setDragInfo(dragInfoRef.current);
        setGhostPos({ x: touch.clientX, y: touch.clientY });
        const pos = getDayAndMinute(touch.clientX, touch.clientY);
        setDragPosition(pos);
      }, 300);

      const onTouchMoveLocal = (te: TouchEvent) => {
        if (te.touches.length === 1) {
          const dx = te.touches[0].clientX - touch.clientX;
          const dy = te.touches[0].clientY - touch.clientY;
          if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
            clearTimeout(longPressTimer);
            if (!isDraggingRef.current) {
              // User scrolled instead — cancel
              dragInfoRef.current = null;
              startPosRef.current = null;
              window.removeEventListener('touchmove', onTouchMoveLocal);
              window.removeEventListener('touchend', onTouchEndLocal);
              window.removeEventListener('touchcancel', onTouchEndLocal);
            }
          }
        }
      };
      const onTouchEndLocal = () => {
        clearTimeout(longPressTimer);
        if (!isDraggingRef.current) {
          dragInfoRef.current = null;
          startPosRef.current = null;
        }
        window.removeEventListener('touchmove', onTouchMoveLocal);
        window.removeEventListener('touchend', onTouchEndLocal);
        window.removeEventListener('touchcancel', onTouchEndLocal);
      };
      window.addEventListener('touchmove', onTouchMoveLocal, { passive: true });
      window.addEventListener('touchend', onTouchEndLocal);
      window.addEventListener('touchcancel', onTouchEndLocal);
    },
  });

  return {
    isDragging,
    dragInfo,
    dragPosition,
    ghostPos,
    dragClientWindows,
    isValidDropPosition,
    createDragHandlers,
    justFinishedDragRef,
  };
}

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
