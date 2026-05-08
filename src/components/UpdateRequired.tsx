import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Shown when the API returns 410 (removed endpoints) or the server requires a newer build.
 */
export function UpdateRequired({ detail }: { detail?: unknown }) {
  const min =
    detail && typeof detail === 'object' && detail !== null && 'minClientVersion' in detail
      ? String((detail as { minClientVersion?: string }).minClientVersion ?? '')
      : '';

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle>Update required</CardTitle>
          <CardDescription>
            This build is out of date and can no longer talk to the server. Please refresh the page
            or deploy a newer web bundle.
            {min ? ` (minimum client version: ${min})` : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
