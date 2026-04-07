import React, { useRef, useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { MapPin, Loader2 } from 'lucide-react';
import { waitForGoogle } from '@/lib/google-maps';

interface AddressSearchProps {
  value: string;
  onChange: (address: string, coords?: { lat: number; lon: number }) => void;
  placeholder?: string;
  id?: string;
}

export function AddressSearch({ value, onChange, placeholder = '123 Main St, City', id }: AddressSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    waitForGoogle().then(() => {
      if (cancelled || !inputRef.current) return;

      const autocomplete = new google.maps.places.Autocomplete(inputRef.current, {
        types: ['address'],
        fields: ['formatted_address', 'geometry'],
      });

      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        if (place.formatted_address && place.geometry?.location) {
          onChange(place.formatted_address, {
            lat: place.geometry.location.lat(),
            lon: place.geometry.location.lng(),
          });
        }
      });

      autocompleteRef.current = autocomplete;
      setReady(true);
    });

    return () => { cancelled = true; };
  }, []);

  // Sync external value changes to the input
  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== value) {
      inputRef.current.value = value;
    }
  }, [value]);

  return (
    <div className="relative">
      <MapPin className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground z-10" />
      <Input
        ref={inputRef}
        id={id}
        defaultValue={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8"
      />
      {!ready && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-muted-foreground" />}
    </div>
  );
}
