import { useNavigate } from 'react-router-dom';
import { Button } from '@capra/core';

/** Primary CTA that sends the user to the Setup tab. */
export function SetupPulseButton() {
  const navigate = useNavigate();
  return <Button variant="primary" onClick={() => navigate('/settings/setup')}>Set up Pulse</Button>;
}
