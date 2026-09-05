import { useState } from 'react';

export default function AddressForm({ onSubmit, loading = false, error = '' }) {
  const [address, setAddress] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = address.trim();
    if (!trimmed || loading) return;
    await onSubmit?.(trimmed);
  };

  return (
    <form className="address-form" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Adresse ou lieu (ex: Paris, Lyon, Tokyo)"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        disabled={loading}
        aria-label="Adresse"
      />
      <button type="submit" disabled={loading || !address.trim()}>
        {loading ? 'Chargement...' : 'Go'}
      </button>
      {error ? <span className="error">{error}</span> : null}
    </form>
  );
}
