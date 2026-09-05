import { useEffect, useRef, useState } from 'react';
import WorldEngine from '../engine/WorldEngine.js';
import AddressForm from './AddressForm.jsx';

export default function App() {
  const containerRef = useRef(null);
  const engineRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!containerRef.current) return;
    const engine = new WorldEngine({ container: containerRef.current });
    engine.init();
    engineRef.current = engine;
    return () => engine.dispose();
  }, []);

  const handleAddressSubmit = async (address) => {
    if (!engineRef.current) return;
    setError('');
    setLoading(true);
    const ok = await engineRef.current.setAddress(address);
    if (!ok) setError('Adresse introuvable ou erreur réseau.');
    setLoading(false);
  };

  return (
    <div className="app-root">
      <div className="canvas-container" ref={containerRef} />
      <div className="ui-layer">
        <AddressForm onSubmit={handleAddressSubmit} loading={loading} error={error} />
      </div>
    </div>
  );
}
