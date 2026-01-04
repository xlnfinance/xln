/**
 * /graph redirect - Backward compatibility
 * Redirects to /app with query params preserved
 */

export const GET = ({ url }: { url: URL }) => {
  const params = url.searchParams.toString();
  const target = `/app${params ? '?' + params : ''}`;

  return new Response(null, {
    status: 301,
    headers: {
      Location: target
    }
  });
};
