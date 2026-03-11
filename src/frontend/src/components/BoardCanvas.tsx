import { useRef, useEffect } from 'react';
import { BoardRenderer } from '../renderer/BoardRenderer';

export function BoardCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let destroyed = false;
    let renderer: BoardRenderer | null = null;

    (async () => {
      renderer = new BoardRenderer(container);
      await renderer.init();
      if (destroyed) {
        renderer.destroy();
      }
    })();

    return () => {
      destroyed = true;
      if (renderer) {
        renderer.destroy();
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', overflow: 'hidden' }}
      data-testid="board-canvas"
    />
  );
}
