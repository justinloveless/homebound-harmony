/// <reference types="google.maps" />
/** Utilities for Google Maps APIs (Places Autocomplete + Distance Matrix) */

const API_KEY = "AIzaSyCGQHsMGKk-IQ8hQaKV0lo9IEYoF7IBD40";

/** Wait until the Google Maps script is loaded */
export function waitForGoogle(): Promise<typeof google> {
  return new Promise((resolve) => {
    if (typeof google !== "undefined" && google.maps) {
      resolve(google);
      return;
    }
    const check = setInterval(() => {
      if (typeof google !== "undefined" && google.maps) {
        clearInterval(check);
        resolve(google);
      }
    }, 100);
  });
}

export interface DistanceResult {
  durationMinutes: number;
  distanceMeters: number;
}

export interface BatchResult {
  originIndex: number;
  destIndex: number;
  durationMinutes: number | null;
  error?: string;
}

/**
 * Google Distance Matrix API limit: max 25 origins or 25 destinations,
 * and max 100 elements (origins × destinations) per request.
 * We chunk accordingly.
 */
const MAX_ELEMENTS_PER_REQUEST = 25;

/** Sleep helper for rate limiting */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Calculate travel times in batches to avoid MAX_ELEMENTS_EXCEEDED.
 * Yields progress via onProgress callback.
 * Returns results for all requested pairs.
 */
export async function getDistanceMatrixBatched(
  origins: string[],
  destinations: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult[]> {
  await waitForGoogle();
  const service = new google.maps.DistanceMatrixService();

  // Build list of all (i, j) pairs we need
  const pairs: { oi: number; di: number }[] = [];
  for (let oi = 0; oi < origins.length; oi++) {
    for (let di = 0; di < destinations.length; di++) {
      pairs.push({ oi, di });
    }
  }

  const totalPairs = pairs.length;
  const allResults: BatchResult[] = [];
  let completed = 0;

  // Chunk pairs into batches where origins × destinations ≤ MAX_ELEMENTS
  // Strategy: group by unique origins, limit destinations per batch
  const batches: { originIndices: number[]; destIndices: number[] }[] = [];

  // Simple approach: iterate origins one at a time, chunk destinations
  for (let oi = 0; oi < origins.length; oi++) {
    for (let dStart = 0; dStart < destinations.length; dStart += MAX_ELEMENTS_PER_REQUEST) {
      const dEnd = Math.min(dStart + MAX_ELEMENTS_PER_REQUEST, destinations.length);
      const destIndices = Array.from({ length: dEnd - dStart }, (_, i) => dStart + i);
      
      // Try to merge with existing batch for same dest range
      const existing = batches.find(
        b => b.destIndices.length === destIndices.length &&
             b.destIndices[0] === destIndices[0] &&
             (b.originIndices.length + 1) * destIndices.length <= MAX_ELEMENTS_PER_REQUEST
      );
      if (existing) {
        existing.originIndices.push(oi);
      } else {
        batches.push({ originIndices: [oi], destIndices });
      }
    }
  }

  for (const batch of batches) {
    const batchOrigins = batch.originIndices.map((i) => origins[i]);
    const batchDests = batch.destIndices.map((i) => destinations[i]);

    try {
      const response = await new Promise<google.maps.DistanceMatrixResponse>(
        (resolve, reject) => {
          service.getDistanceMatrix(
            {
              origins: batchOrigins,
              destinations: batchDests,
              travelMode: google.maps.TravelMode.DRIVING,
              unitSystem: google.maps.UnitSystem.IMPERIAL,
            },
            (response, status) => {
              if (status !== "OK" || !response) {
                reject(new Error(`Distance Matrix API error: ${status}`));
                return;
              }
              resolve(response);
            },
          );
        },
      );

      // Process response
      for (let ri = 0; ri < response.rows.length; ri++) {
        for (let ci = 0; ci < response.rows[ri].elements.length; ci++) {
          const el = response.rows[ri].elements[ci];
          const originIndex = batch.originIndices[ri];
          const destIndex = batch.destIndices[ci];

          if (el.status === "OK") {
            allResults.push({
              originIndex,
              destIndex,
              durationMinutes: Math.round(el.duration.value / 60),
            });
          } else {
            allResults.push({
              originIndex,
              destIndex,
              durationMinutes: null,
              error: `Status: ${el.status}`,
            });
          }
          completed++;
        }
      }
    } catch (err) {
      // Mark all pairs in this batch as failed
      for (const oi of batch.originIndices) {
        for (const di of batch.destIndices) {
          allResults.push({
            originIndex: oi,
            destIndex: di,
            durationMinutes: null,
            error: err instanceof Error ? err.message : "Unknown error",
          });
          completed++;
        }
      }
    }

    onProgress?.(completed, totalPairs);

    // Rate limit: small delay between batches
    if (batches.indexOf(batch) < batches.length - 1) {
      await sleep(200);
    }
  }

  return allResults;
}

/**
 * Calculate travel times for a single new location against all existing locations.
 * Used when adding a new client.
 */
export async function getDistanceForNewLocation(
  newAddress: string,
  existingAddresses: string[],
): Promise<{ toResults: (number | null)[]; fromResults: (number | null)[] }> {
  if (!newAddress.trim() || existingAddresses.length === 0) {
    return { toResults: [], fromResults: [] };
  }

  await waitForGoogle();
  const service = new google.maps.DistanceMatrixService();

  // New → existing
  const toPromise = new Promise<(number | null)[]>((resolve, reject) => {
    service.getDistanceMatrix(
      {
        origins: [newAddress],
        destinations: existingAddresses,
        travelMode: google.maps.TravelMode.DRIVING,
        unitSystem: google.maps.UnitSystem.IMPERIAL,
      },
      (response, status) => {
        if (status !== "OK" || !response) {
          resolve(existingAddresses.map(() => null));
          return;
        }
        resolve(
          response.rows[0].elements.map((el) =>
            el.status === "OK" ? Math.round(el.duration.value / 60) : null,
          ),
        );
      },
    );
  });

  // Existing → new
  const fromPromise = new Promise<(number | null)[]>((resolve, reject) => {
    service.getDistanceMatrix(
      {
        origins: existingAddresses,
        destinations: [newAddress],
        travelMode: google.maps.TravelMode.DRIVING,
        unitSystem: google.maps.UnitSystem.IMPERIAL,
      },
      (response, status) => {
        if (status !== "OK" || !response) {
          resolve(existingAddresses.map(() => null));
          return;
        }
        resolve(
          response.rows.map((row) =>
            row.elements[0].status === "OK"
              ? Math.round(row.elements[0].duration.value / 60)
              : null,
          ),
        );
      },
    );
  });

  const [toResults, fromResults] = await Promise.all([toPromise, fromPromise]);
  return { toResults, fromResults };
}

/**
 * Refine a day's schedule using Google Maps with departure-time-aware travel estimates.
 * Takes the ordered list of addresses for a day route (home → clients → home)
 * and the departure date/time, returns updated travel times in minutes for each leg.
 */
export async function getTimeDependentTravelTimes(
  addresses: string[],
  departureDate: Date,
  onProgress?: (msg: string) => void,
): Promise<{ travelMinutes: (number | null)[]; durationInTraffic: (number | null)[]; distanceMiles: (number | null)[] }> {
  if (addresses.length < 2) return { travelMinutes: [], durationInTraffic: [], distanceMiles: [] };

  await waitForGoogle();
  const service = new google.maps.DistanceMatrixService();

  const travelMinutes: (number | null)[] = [];
  const durationInTraffic: (number | null)[] = [];
  const distanceMiles: (number | null)[] = [];

  // Calculate each sequential leg with departure time
  let currentDepartureTime = departureDate;

  for (let i = 0; i < addresses.length - 1; i++) {
    const origin = addresses[i];
    const dest = addresses[i + 1];

    onProgress?.(`Calculating leg ${i + 1} of ${addresses.length - 1}...`);

    try {
      const response = await new Promise<google.maps.DistanceMatrixResponse>(
        (resolve, reject) => {
          service.getDistanceMatrix(
            {
              origins: [origin],
              destinations: [dest],
              travelMode: google.maps.TravelMode.DRIVING,
              drivingOptions: {
                departureTime: currentDepartureTime,
                trafficModel: google.maps.TrafficModel.BEST_GUESS,
              },
            },
            (response, status) => {
              if (status !== 'OK' || !response) {
                reject(new Error(`Distance Matrix error: ${status}`));
                return;
              }
              resolve(response);
            },
          );
        },
      );

      const el = response.rows[0].elements[0];
      if (el.status === 'OK') {
        const baseMins = Math.round(el.duration.value / 60);
        const trafficMins = el.duration_in_traffic
          ? Math.round(el.duration_in_traffic.value / 60)
          : baseMins;
        const miles = Math.round(el.distance.value / 1609.34 * 10) / 10; // meters to miles, 1 decimal
        travelMinutes.push(baseMins);
        durationInTraffic.push(trafficMins);
        distanceMiles.push(miles);

        currentDepartureTime = new Date(
          currentDepartureTime.getTime() + trafficMins * 60 * 1000,
        );
      } else {
        travelMinutes.push(null);
        durationInTraffic.push(null);
        distanceMiles.push(null);
      }
    } catch (err) {
      console.error(`Leg ${i + 1} failed:`, err);
      travelMinutes.push(null);
      durationInTraffic.push(null);
      distanceMiles.push(null);
    }

    // Rate limit between legs
    if (i < addresses.length - 2) {
      await sleep(150);
    }
  }

  return { travelMinutes, durationInTraffic, distanceMiles };
}
