import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { evvVisits, clients, workers, tenants } from '../db/schema';

export interface EvvPayload {
  provider: {
    vendorId: string;
  };
  member: {
    medicaidId: string;
    name: string;
  };
  caregiver: {
    employeeId: string;
    name: string;
    npi: string;
  };
  service: {
    code: string;
    date: string;      // YYYY-MM-DD in America/Chicago
    startTime: string; // HH:MM in America/Chicago
    endTime: string;   // HH:MM in America/Chicago
    units: number;
  };
  verification: {
    method: string;
    checkIn: { lat: number; lon: number; accuracyM: number };
    checkOut: { lat: number; lon: number; accuracyM: number } | null;
  };
}

export interface AggregatorResult {
  accepted: boolean;
  externalId?: string;
  rejectionReason?: string;
}

function toCentral(date: Date): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

export async function buildEvvPayload(tenantId: string, visitId: string): Promise<EvvPayload> {
  const [visit] = await db
    .select()
    .from(evvVisits)
    .where(and(eq(evvVisits.id, visitId), eq(evvVisits.tenantId, tenantId)))
    .limit(1);
  if (!visit) throw new Error(`Visit ${visitId} not found`);
  if (!visit.checkOutAt) throw new Error('Visit has no check-out time');

  const [client] = await db
    .select({ name: clients.name, medicaidId: clients.medicaidId })
    .from(clients)
    .where(eq(clients.id, visit.clientId))
    .limit(1);

  const [worker] = await db
    .select({ name: workers.name, employeeId: workers.employeeId, npi: workers.npi })
    .from(workers)
    .where(eq(workers.id, visit.workerId))
    .limit(1);

  const [tenant] = await db
    .select({ evvVendorId: tenants.evvVendorId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const startCentral = toCentral(visit.checkInAt);
  const endCentral = toCentral(visit.checkOutAt);

  return {
    provider: {
      vendorId: tenant?.evvVendorId ?? '',
    },
    member: {
      medicaidId: client?.medicaidId ?? '',
      name: client?.name ?? '',
    },
    caregiver: {
      employeeId: worker?.employeeId ?? '',
      name: worker?.name ?? '',
      npi: worker?.npi ?? '',
    },
    service: {
      code: visit.serviceCode ?? 'T1019',
      date: startCentral.date,
      startTime: startCentral.time,
      endTime: endCentral.time,
      units: visit.billableUnits ?? 0,
    },
    verification: {
      method: visit.verificationMethod,
      checkIn: {
        lat: visit.checkInLat,
        lon: visit.checkInLon,
        accuracyM: visit.checkInAccuracyM,
      },
      checkOut:
        visit.checkOutLat != null && visit.checkOutLon != null
          ? {
              lat: visit.checkOutLat,
              lon: visit.checkOutLon,
              accuracyM: visit.checkOutAccuracyM ?? 0,
            }
          : null,
    },
  };
}

export async function submitToAggregator(
  tenantId: string,
  payload: EvvPayload,
): Promise<AggregatorResult> {
  const aggregatorUrl = process.env.EVV_AGGREGATOR_URL;

  if (!aggregatorUrl) {
    // Development stub — simulate acceptance with a short delay
    await new Promise((r) => setTimeout(r, 200));
    return { accepted: true, externalId: `stub-${crypto.randomUUID()}` };
  }

  const [tenant] = await db
    .select({ evvApiKeyEncrypted: tenants.evvApiKeyEncrypted })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const apiKey = tenant?.evvApiKeyEncrypted ?? process.env.EVV_AGGREGATOR_API_KEY ?? '';

  const res = await fetch(aggregatorUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Aggregator HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    accepted?: boolean;
    externalId?: string;
    rejectionReason?: string;
    status?: string;
    id?: string;
    message?: string;
  };

  const accepted = json.accepted ?? json.status === 'accepted' ?? false;
  return {
    accepted,
    externalId: json.externalId ?? json.id,
    rejectionReason: accepted ? undefined : (json.rejectionReason ?? json.message ?? 'Rejected by aggregator'),
  };
}
