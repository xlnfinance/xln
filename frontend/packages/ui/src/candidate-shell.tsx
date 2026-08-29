import { getSurface, type SurfaceId } from '../../../config/surfaces';
import './candidate-shell.css';

export type CandidateSurfaceCopy = Readonly<{
  eyebrow: string;
  title: string;
  summary: string;
}>;

type CandidateShellProps = Readonly<{
  surfaceId: SurfaceId;
  copy: CandidateSurfaceCopy;
}>;

export function CandidateShell({ surfaceId, copy }: CandidateShellProps) {
  const surface = getSurface(surfaceId);
  return (
    <main className="candidate-shell" data-surface={surfaceId}>
      <header className="candidate-header">
        <span className="candidate-brand" aria-label="xln">xln</span>
        <span className="candidate-build">react candidate / {surfaceId}</span>
      </header>

      <section className="candidate-intro" aria-labelledby="candidate-title">
        <p className="candidate-eyebrow">{copy.eyebrow}</p>
        <h1 id="candidate-title">{copy.title}</h1>
        <p className="candidate-summary">{copy.summary}</p>
        <p className="candidate-status" role="status">
          <span className="candidate-status-dot" aria-hidden="true" />
          Isolated build ready for migration slices
        </p>
      </section>

      <dl className="candidate-meta">
        <div>
          <dt>Owned routes</dt>
          <dd className="candidate-routes">
            {surface.routes.map((route) => (
              <code key={`${route.kind}:${route.pathname}`}>
                {route.pathname}{route.kind === 'prefix' ? '/**' : ''}
              </code>
            ))}
          </dd>
        </div>
        <div>
          <dt>Artifact</dt>
          <dd><code>{surface.artifactDirectory}</code></dd>
        </div>
        <div>
          <dt>Development port</dt>
          <dd><code>{surface.developmentPort}</code></dd>
        </div>
      </dl>
    </main>
  );
}
