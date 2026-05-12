import { Badge } from '@/components/ui/badge';
import { CheckCircle, XCircle, Clock } from 'lucide-react';

interface Props {
  isBillable: boolean;
  visitStatus: string;
}

export function BillingStatusBadge({ isBillable, visitStatus }: Props) {
  if (visitStatus === 'in_progress') {
    return (
      <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 gap-1">
        <Clock className="h-3 w-3" />
        In Progress
      </Badge>
    );
  }

  if (visitStatus !== 'completed') {
    return (
      <Badge variant="outline" className="bg-gray-100 text-gray-600 gap-1">
        {visitStatus}
      </Badge>
    );
  }

  if (isBillable) {
    return (
      <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 gap-1">
        <CheckCircle className="h-3 w-3" />
        Billable
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 gap-1">
      <XCircle className="h-3 w-3" />
      Not Billable
    </Badge>
  );
}
