import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Header } from './components/Header.tsx';
import { ControlPanel } from './components/ControlPanel.tsx';
import { ClientList } from './components/ClientList.tsx';
import { QrCodeDisplay } from './components/QrCodeDisplay.tsx';
import { AuthMethodSelector } from './components/AuthMethodSelector.tsx';
import { PhoneCodeDisplay } from './components/PhoneCodeDisplay.tsx';
import { ConfirmDisconnectModal } from './components/ConfirmDisconnectModal.tsx';
import { BotStatus, Client, PhoneAuthState } from './types.ts';
import api from './services/mockApi.ts'; // Gerçek API servisine işaret ediyor

// Uygulamanın genel durumlarını daha net tanımlayalım
type AuthState = 'idle' | 'selecting' | 'qr_loading' | 'qr_displaying' | 'qr_expired' | PhoneAuthState;
type QrDisplayState = 'loading' | 'displaying' | 'expired';

function App() {
  const [clients, setClients] = useState<Client[]>([]);
  const [authState, setAuthState] = useState<AuthState>('idle');
  const [activeClient, setActiveClient] = useState<Client | null>(null);
  const [authSessionId, setAuthSessionId] = useState<string | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [phoneLinkCode, setPhoneLinkCode] = useState<string | null>(null);
  const [clientToDelete, setClientToDelete] = useState<string | null>(null);

  // --- DATA SYNC ---

  const syncClients = useCallback(async () => {
    try {
      const fetchedClients = await api.getClients();
      setClients(fetchedClients);
    } catch (error) {
      console.error("İstemciler senkronize edilirken hata oluştu:", error);
    }
  }, []);

  // İlk veri çekme
  useEffect(() => {
    syncClients();
  }, [syncClients]);

  // Periyodik olarak veri senkronizasyonu (polling)
  useEffect(() => {
    const pollInterval = 1000;
    const intervalId = setInterval(() => {
      // Bir işlem devam ederken (auth, silme onayı) polling'i duraklat
      if (authState === 'idle' && !clientToDelete) {
        syncClients();
      }
    }, pollInterval);

    return () => clearInterval(intervalId);
  }, [authState, syncClients, clientToDelete]);


  // --- AUTH FLOW MANAGEMENT ---

  const resetAuthState = useCallback(() => {
    setAuthState('idle');
    setActiveClient(null);
    setAuthSessionId(null);
    setQrCodeUrl(null);
    setPhoneLinkCode(null);
  }, []);

  const handleCancelAuth = useCallback(async () => {
    if (authSessionId) {
      try {
        await api.cancelAuthSession(authSessionId);
      } catch (e) {
        console.error("Auth oturumu iptal edilemedi:", e);
      }
    }
    resetAuthState();
    // Auth iptal edildikten sonra en güncel listeyi çekelim
    syncClients();
  }, [authSessionId, resetAuthState, syncClients]);

  // Auth durumu kontrolü için sağlamlaştırılmış polling
  useEffect(() => {
    const shouldPoll = ['qr_displaying', 'phone_displaying'].includes(authState) && authSessionId;
    if (!shouldPoll) {
      return;
    }

    let isCancelled = false;
    let timeoutId: number;

    const poll = async () => {
      if (isCancelled) return;

      try {
        const result = await api.checkAuthStatus(authSessionId);
        if (isCancelled) return;

        if (result.status === 'paired') {
          isCancelled = true;
          console.log("✅ Eşleşme tamamlandı! Arayüz güncelleniyor.", result.client);
          
          // Eşleşen istemciyi listede güncelle veya ekle
          setClients(prevClients => {
            const clientExists = prevClients.some(c => c.id === result.client.id);
            if (clientExists) {
              return prevClients.map(c => c.id === result.client.id ? result.client : c);
            }
            return [...prevClients, result.client];
          });
          resetAuthState();

        } else {
          // 'pending' durumu, devam et
          timeoutId = window.setTimeout(poll, 2000);
        }
      } catch (error) {
        if (isCancelled) return;
        isCancelled = true;
        console.error("Auth durumu kontrol edilirken hata:", error);

        if (error instanceof Error && error.message === 'EXPIRED') {
          if (authState === 'qr_displaying') setAuthState('qr_expired');
          if (authState === 'phone_displaying') setAuthState('phone_expired');
        } else {
          handleCancelAuth();
        }
      }
    };

    poll(); // İlk sorguyu başlat

    return () => {
      isCancelled = true;
      clearTimeout(timeoutId);
    };
  }, [authState, authSessionId, resetAuthState, handleCancelAuth]);


  // --- CLIENT ACTIONS ---

  const handleStartClient = async (clientId: string) => {
    setClients(prev => prev.map(c => c.id === clientId ? { ...c, status: BotStatus.STARTING } : c));
    try {
      await api.startClient(clientId);
    } catch (error) {
      console.error(`İstemci ${clientId} başlatılamadı:`, error);
    } finally {
      syncClients(); // Her durumda en güncel listeyi çek
    }
  };
  
  const handleStopClient = async (clientId: string) => {
    setClients(prev => prev.map(c => c.id === clientId ? { ...c, status: BotStatus.STOPPING } : c));
    try {
      await api.stopClient(clientId);
    } catch (error) {
      console.error(`İstemci ${clientId} durdurulamadı:`, error);
    } finally {
      syncClients();
    }
  };

  const handleAddClient = async () => {
    if (authState !== 'idle') return;
    try {
      const newClient = await api.createClient(); // Backend'de yeni bir istemci oluştur
      setClients(prev => [...prev, newClient]); // UI'a hemen ekle
      setActiveClient(newClient);
      setAuthState('selecting');
    } catch (error) {
      console.error("Yeni istemci oluşturulamadı:", error);
    }
  };

  const handleActivateClient = (clientId: string) => {
    const clientToActivate = clients.find(c => c.id === clientId);
    if (clientToActivate) {
      setActiveClient(clientToActivate);
      setAuthState('selecting');
    }
  };

  const handleSelectAuthMethod = async (method: 'qr' | 'phone') => {
    if (!activeClient) return;

    if (method === 'qr') {
      setAuthState('qr_loading');
      setQrCodeUrl(null);
      try {
        const { qrCodeUrl: url, sessionId } = await api.generateQrCode(activeClient.id);
        setQrCodeUrl(url);
        setAuthSessionId(sessionId);
        setAuthState('qr_displaying');
      } catch (error) {
        console.error("QR kodu oluşturulamadı:", error);
        setAuthState('qr_expired');
      }
    } else if (method === 'phone') {
        setAuthState('phone_input');
    }
  };
  
  const handlePhoneNumberSubmit = async (phoneNumber: string) => {
      if (!activeClient) return;
      setAuthState('phone_loading');
      try {
          const { code, sessionId } = await api.generatePhoneCode(activeClient.id, phoneNumber);
          setPhoneLinkCode(code);
          setAuthSessionId(sessionId);
          setAuthState('phone_displaying');
      } catch (error) {
          console.error("Telefon kodu oluşturulamadı:", error);
          setAuthState('phone_expired');
      }
  };

  // --- DISCONNECT FLOW ---

  const handleRequestDisconnect = (clientId: string) => {
    setClientToDelete(clientId);
  };
  
  const handleCancelDisconnect = () => {
    setClientToDelete(null);
  };

  const handleConfirmDisconnect = async () => {
    if (!clientToDelete) return;
    try {
      await api.disconnectClient(clientToDelete);
      setClients(prevClients => prevClients.filter(c => c.id !== clientToDelete));
    } catch (error) {
      console.error(`İstemci ${clientToDelete} bağlantısı kesilemedi:`, error);
    } finally {
      setClientToDelete(null);
    }
  };

  const clientPendingDeletion = useMemo(() => {
    if (!clientToDelete) return null;
    return clients.find(c => c.id === clientToDelete);
  }, [clientToDelete, clients]);


  // --- RENDER LOGIC ---

  const mapAuthStateToQrDisplayState = (state: AuthState): QrDisplayState | null => {
      if (state === 'qr_loading') return 'loading';
      if (state === 'qr_displaying') return 'displaying';
      if (state === 'qr_expired') return 'expired';
      return null;
  }
  
  const renderAuthComponent = () => {
      const qrDisplayState = mapAuthStateToQrDisplayState(authState);

      if (authState === 'selecting') {
          return <AuthMethodSelector onSelect={handleSelectAuthMethod} onCancel={handleCancelAuth} clientName={activeClient?.name} />
      }
      if (qrDisplayState) {
          return <QrCodeDisplay 
                    qrState={qrDisplayState}
                    qrCodeUrl={qrCodeUrl}
                    onCancel={handleCancelAuth}
                    onRegenerate={() => handleSelectAuthMethod('qr')}
                    reconnectingClientName={activeClient?.name}
                  />
      }
      if (authState.startsWith('phone_')) {
          return <PhoneCodeDisplay
                    authState={authState as PhoneAuthState}
                    onSubmitPhoneNumber={handlePhoneNumberSubmit}
                    onRegenerate={() => setAuthState('phone_input')}
                    onCancel={handleCancelAuth}
                    linkCode={phoneLinkCode}
                    clientName={activeClient?.name}
                  />
      }
      return null;
  };

  return (
    <div className="min-h-screen text-neutral-200 font-sans">
      <Header />
      <main className="container mx-auto p-4 md:p-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1 space-y-8">
            <ControlPanel
              onAddClient={handleAddClient}
              isAddingClient={authState !== 'idle'}
            />
            {renderAuthComponent()}
          </div>
          <div className="lg:col-span-2">
            <ClientList 
              clients={clients}
              onStartClient={handleStartClient}
              onStopClient={handleStopClient}
              onDisconnectRequest={handleRequestDisconnect}
              onReconnectClient={handleActivateClient} 
            />
          </div>
        </div>
      </main>
      {clientPendingDeletion && (
        <ConfirmDisconnectModal
            client={clientPendingDeletion}
            onConfirm={handleConfirmDisconnect}
            onCancel={handleCancelDisconnect}
        />
      )}
    </div>
  );
}

export default App;