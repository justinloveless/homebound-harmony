/** Utilities for Google Maps APIs (Places Autocomplete + Distance Matrix) */

const API_KEY = 'AIzaSyCGQHsMGKk-IQ8hQaKV0lo9IEYoF7IBD40';

/** Wait until the Google Maps script is loaded */
export function waitForGoogle(): Promise<typeof google> {
  return new Promise((resolve) => {
    if (typeof google !== 'undefined' && google.maps) {
      resolve(google);
      return;
    }
    const check = setInterval(() => {
      if (typeof google !== 'undefined' && google.maps) {
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

/**
 * Calculate travel time between two addresses using the Distance Matrix API (REST).
 * Returns duration in minutes.
 */
export async function getDistanceMatrix(
  origins: string[],
  destinations: string[]
): Promise<(DistanceResult | null)[][]> {
  const originsParam = origins.map(o => encodeURIComponent(o)).join('|');
  const destsParam = destinations.map(d => encodeURIComponent(d)).join('|');

  const res = await fetch(
    `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originsParam}&destinations=${destsParam}&units=imperial&key=${API_KEY}`
  );

  // The Distance Matrix REST API has CORS restrictions from browsers,
  // so we'll use the JS SDK instead
  throw new Error('Use JS SDK version instead');
}

/**
 * Calculate travel times using the Google Maps JS SDK Distance Matrix Service.
 * Returns a 2D array [origin][destination] of duration in minutes.
 */
export async function getDistanceMatrixSDK(
  origins: string[],
  destinations: string[]
): Promise<(number | null)[][]> {
  await waitForGoogle();

  const service = new google.maps.DistanceMatrixService();

  return new Promise((resolve, reject) => {
    service.getDistanceMatrix(
      {
        origins,
        destinations,
        travelMode: google.maps.TravelMode.DRIVING,
        unitSystem: google.maps.UnitSystem.IMPERIAL,
      },
      (response, status) => {
        if (status !== 'OK' || !response) {
          reject(new Error(`Distance Matrix failed: ${status}`));
          return;
        }

        const results: (number | null)[][] = response.rows.map(row =>
          row.elements.map(el =>
            el.status === 'OK' ? Math.round(el.duration.value / 60) : null
          )
        );
        resolve(results);
      }
    );
  });
}
