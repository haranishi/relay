export function SofaVisual({ caption }: { caption?: string }) {
  return (
    <div className="sofa-visual" role="img" aria-label="譲渡予定のグリーンの二人掛けソファ">
      <span className="visual-tag">無料</span>
      <div className="sun" />
      <div className="plant"><i /><b /><b /><b /></div>
      <div className="sofa"><span className="sofa-back" /><span className="sofa-seat" /><i /><b /></div>
      {caption && <span className="visual-caption">{caption}</span>}
    </div>
  );
}
