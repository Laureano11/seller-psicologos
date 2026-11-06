export type RawProspect = {
  name: string;
  phone?: string;
  website?: string;
  address?: string;
  city: string;
  province: string;
  source: string;
  sourceRef: string;
  profileUrls?: string[];
};

export interface ProspectSource {
  name: string;
  search(q: { city: string; province: string }): Promise<RawProspect[]>;
}

type Place = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
};

export function createGooglePlacesSource(apiKey: string, fetchFn: typeof fetch = fetch): ProspectSource {
  return {
    name: 'google_places',
    async search({ city, province }) {
      const res = await fetchFn('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri',
        },
        body: JSON.stringify({ textQuery: `psicólogo en ${city}, ${province}, Argentina`, languageCode: 'es' }),
      });
      if (!res.ok) throw new Error(`Google Places respondió ${res.status}`);
      const data = (await res.json()) as { places?: Place[] };
      return (data.places ?? []).map((p) => ({
        name: p.displayName?.text ?? '',
        phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber,
        website: p.websiteUri,
        address: p.formattedAddress,
        city,
        province,
        source: 'google_places',
        sourceRef: p.id,
      })).filter((r) => r.name);
    },
  };
}
