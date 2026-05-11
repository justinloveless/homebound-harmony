import { useRef, useEffect, useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';

interface Props {
  onSign: (svgPath: string) => void;
  disabled?: boolean;
}

type Point = [number, number];

function buildSvgPath(strokes: Point[][]): string {
  return strokes
    .filter((s) => s.length > 0)
    .map((stroke) =>
      stroke.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(' '),
    )
    .join(' ');
}

export function SignaturePad({ onSign, disabled }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Point[][]>([]);
  const currentStrokeRef = useRef<Point[]>([]);
  const isDrawingRef = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);

  const getPos = (e: PointerEvent): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  };

  const draw = useCallback((from: Point, to: Point) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(to[0], to[1]);
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onDown = (e: PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = true;
      const pos = getPos(e);
      currentStrokeRef.current = [pos];
    };

    const onMove = (e: PointerEvent) => {
      if (!isDrawingRef.current || disabled) return;
      e.preventDefault();
      const pos = getPos(e);
      const stroke = currentStrokeRef.current;
      const prev = stroke[stroke.length - 1];
      stroke.push(pos);
      draw(prev, pos);
    };

    const onUp = (e: PointerEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      isDrawingRef.current = false;
      const stroke = currentStrokeRef.current;
      if (stroke.length > 0) {
        strokesRef.current = [...strokesRef.current, stroke];
        currentStrokeRef.current = [];
        setHasSignature(true);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, [draw, disabled]);

  const clear = useCallback(() => {
    strokesRef.current = [];
    currentStrokeRef.current = [];
    setHasSignature(false);
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }, []);

  const handleConfirm = useCallback(() => {
    const path = buildSvgPath(strokesRef.current);
    if (path) onSign(path);
  }, [onSign]);

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">Sign below to attest this visit documentation</div>
      <div className="relative border rounded-lg overflow-hidden bg-white">
        <canvas
          ref={canvasRef}
          width={600}
          height={160}
          className="w-full touch-none cursor-crosshair"
          style={{ display: 'block' }}
        />
        {!hasSignature && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-muted-foreground/40 text-sm select-none">Sign here</span>
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={clear}
          disabled={!hasSignature || disabled}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleConfirm}
          disabled={!hasSignature || disabled}
          className="flex-1"
        >
          Confirm Signature
        </Button>
      </div>
    </div>
  );
}
