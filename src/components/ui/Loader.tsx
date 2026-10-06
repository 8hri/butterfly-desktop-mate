/**
 * Loading veil: a soft full-screen wash that fades the user into the
 * experience. Deliberately non-technical — no percentages or spinners.
 */
export default function Loader({ ready }: { ready: boolean }) {
  return (
    <div className={`loader${ready ? " loader--done" : ""}`} aria-hidden={ready}>
      <span className="loader__dot" />
    </div>
  );
}
