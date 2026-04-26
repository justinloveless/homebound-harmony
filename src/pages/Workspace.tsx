import Clients from './Clients';
import Schedule from './Schedule';

export default function Workspace() {
  return (
    <div className="grid gap-6 xl:grid-cols-2 xl:gap-8 xl:items-start">
      <div className="min-w-0">
        <Clients />
      </div>
      <div className="min-w-0">
        <Schedule />
      </div>
    </div>
  );
}
