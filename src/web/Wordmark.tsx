/** The real Planban wordmark, on every web screen (approved mockup section 6). */
export function Wordmark({ height = 20 }: { height?: number }) {
  return (
    <picture className="web-wordmark">
      <source srcSet="/assets/planban-logo-wordmark-white.svg" media="(prefers-color-scheme: dark)" />
      <img src="/assets/planban-logo-wordmark-black.svg" alt="Planban" style={{ height }} />
    </picture>
  );
}
