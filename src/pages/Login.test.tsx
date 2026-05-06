import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './Login';

const loginMock = vi.fn();
const navigateMock = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    login: loginMock,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe('LoginPage', () => {
  beforeEach(() => {
    loginMock.mockResolvedValue(undefined);
    navigateMock.mockReset();
  });

  it('submits without a TOTP code', async () => {
    // Arrange
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: ' apple.test@gmail.com ' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Assert
    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith('apple.test@gmail.com', 'password123', undefined);
    });
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true });
  });

  it('trims and submits a provided TOTP code', async () => {
    // Arrange
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'worker@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    });
    fireEvent.change(screen.getByLabelText('Authenticator code'), {
      target: { value: ' 123456 ' },
    });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Assert
    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith('worker@example.com', 'password123', '123456');
    });
  });
});
