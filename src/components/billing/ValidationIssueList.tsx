import { AlertTriangle } from 'lucide-react';

export interface ValidationIssue {
  code: string;
  message: string;
}

const ACTION_LINKS: Partial<Record<string, string>> = {
  NOTE_INCOMPLETE: '/visits',
  NOTE_UNSIGNED: '/visits',
};

interface Props {
  issues: ValidationIssue[];
  visitId?: string;
}

export function ValidationIssueList({ issues, visitId }: Props) {
  if (issues.length === 0) return null;

  return (
    <ul className="space-y-1">
      {issues.map((issue) => {
        const href = visitId && ACTION_LINKS[issue.code]
          ? `${ACTION_LINKS[issue.code]}/${visitId}`
          : undefined;

        return (
          <li key={issue.code} className="flex items-start gap-1.5 text-xs text-red-700">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-red-500" />
            <span>
              <span className="font-mono text-[10px] bg-red-100 px-1 rounded mr-1">{issue.code}</span>
              {href ? (
                <a href={href} className="underline hover:no-underline">
                  {issue.message}
                </a>
              ) : (
                issue.message
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
