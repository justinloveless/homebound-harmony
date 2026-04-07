import { useWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { travelKey, DEFAULT_TRAVEL_TIME } from '@/types/models';

export default function TravelTimes() {
  const { workspace, setTravelTimes } = useWorkspace();
  const { clients, travelTimes } = workspace;

  const locations = [
    { id: 'home', name: '🏠 Home' },
    ...clients.map(c => ({ id: c.id, name: c.name })),
  ];

  const getValue = (a: string, b: string) => travelTimes[travelKey(a, b)] ?? DEFAULT_TRAVEL_TIME;

  const handleChange = (a: string, b: string, value: number) => {
    const key = travelKey(a, b);
    setTravelTimes({ ...travelTimes, [key]: value });
  };

  if (clients.length === 0) {
    return (
      <div className="space-y-6 max-w-4xl">
        <h1 className="text-2xl font-bold tracking-tight">Travel Times</h1>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 text-center">
            <p className="font-medium">No clients yet</p>
            <p className="text-sm text-muted-foreground mt-1">Add clients first to set up travel times</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Travel Times</h1>
        <p className="text-sm text-muted-foreground">Estimated drive time in minutes between locations</p>
      </div>

      <Card>
        <CardContent className="pt-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left p-2 font-medium text-muted-foreground sticky left-0 bg-card z-10">From ↓ / To →</th>
                {locations.map(loc => (
                  <th key={loc.id} className="p-2 text-center font-medium text-muted-foreground min-w-[80px]">
                    <span className="text-xs">{loc.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {locations.map(from => (
                <tr key={from.id} className="border-t">
                  <td className="p-2 font-medium text-xs sticky left-0 bg-card z-10">{from.name}</td>
                  {locations.map(to => (
                    <td key={to.id} className="p-1 text-center">
                      {from.id === to.id ? (
                        <span className="text-muted-foreground/30">—</span>
                      ) : (
                        <Input
                          type="number"
                          min={1}
                          value={getValue(from.id, to.id)}
                          onChange={e => handleChange(from.id, to.id, Number(e.target.value))}
                          className="w-16 h-8 text-xs text-center mx-auto"
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Default: {DEFAULT_TRAVEL_TIME} minutes. Travel times are bidirectional — updating one direction updates both.
      </p>
    </div>
  );
}
