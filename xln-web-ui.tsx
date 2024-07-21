import React, { useState, useEffect } from 'react';
import { Camera, Send, PlusCircle, ArrowLeftRight, BarChart2, Clock, PlayCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

const XLNWebUI = () => {
  const [user, setUser] = useState(null);
  const [channels, setChannels] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [message, setMessage] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [history, setHistory] = useState([]);

  useEffect(() => {
    // Simulating user login and channel fetching
    const fetchData = async () => {
      // Replace with actual API calls
      setUser({ address: '0x1234...5678', balance: '10000' });
      setChannels([
        { 
          id: '1', 
          peer: '0xabcd...efgh', 
          chainId: 1,
          tokenId: 1,
          derivedDelta: {
            delta: 500n,
            collateral: 1000n,
            inCollateral: 500n,
            outCollateral: 500n,
            inOwnCredit: 0n,
            outPeerCredit: 0n,
            inAllowance: 100n,
            outAllowance: 100n,
            totalCapacity: 2000n,
            ownCreditLimit: 500n,
            peerCreditLimit: 500n,
            inCapacity: 900n,
            outCapacity: 900n,
          }
        },
        { 
          id: '2', 
          peer: '0x9876...5432', 
          chainId: 1,
          tokenId: 2,
          derivedDelta: {
            delta: -200n,
            collateral: 800n,
            inCollateral: 800n,
            outCollateral: 0n,
            inOwnCredit: 200n,
            outPeerCredit: 0n,
            inAllowance: 50n,
            outAllowance: 50n,
            totalCapacity: 1600n,
            ownCreditLimit: 400n,
            peerCreditLimit: 400n,
            inCapacity: 1350n,
            outCapacity: 350n,
          }
        },
      ]);
      setHistory([
        { type: 'Block', number: 1, timestamp: '2023-07-21 10:00:00', transitions: 2 },
        { type: 'Transition', action: 'Payment', amount: '100', timestamp: '2023-07-21 09:55:00' },
        { type: 'Transition', action: 'AddSubchannel', chainId: 1, timestamp: '2023-07-21 09:50:00' },
      ]);
    };
    fetchData();
  }, []);

  const handleSendMessage = () => {
    if (selectedChannel && message) {
      console.log(`Sending message to ${selectedChannel.peer}: ${message}`);
      setMessage('');
    }
  };

  const handlePayment = () => {
    if (amount && recipient) {
      console.log(`Sending payment of ${amount} to ${recipient}`);
      setAmount('');
      setRecipient('');
    }
  };

  const handleCreateChannel = () => {
    console.log('Creating new channel');
    // Implement channel creation logic
  };

  const handleSwap = () => {
    console.log('Initiating token swap');
    // Implement token swap logic
  };

  const renderCollateralLayout = (channel) => {
    const { derivedDelta } = channel;
    const totalWidth = Number(derivedDelta.totalCapacity);
    const collateralWidth = (Number(derivedDelta.collateral) / totalWidth) * 100;
    const ownCreditWidth = (Number(derivedDelta.ownCreditLimit) / totalWidth) * 100;
    const peerCreditWidth = (Number(derivedDelta.peerCreditLimit) / totalWidth) * 100;
    const deltaPosition = ((Number(derivedDelta.delta) + Number(derivedDelta.ownCreditLimit)) / totalWidth) * 100;

    return (
      <div className="relative w-full h-8 bg-gray-200 rounded-full overflow-hidden flex">
        <div className="bg-red-500" style={{ width: `${ownCreditWidth}%` }}></div>
        <div className="bg-green-500" style={{ width: `${collateralWidth}%` }}></div>
        <div className="bg-red-500" style={{ width: `${peerCreditWidth}%` }}></div>
        <div className="absolute h-full border-l-2 border-black" style={{ left: `${deltaPosition}%` }}></div>
      </div>
    );
  };

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-3xl font-bold mb-4">XLN Wallet</h1>
      
      {user && (
        <Alert className="mb-4">
          <Camera className="h-4 w-4" />
          <AlertTitle>Connected</AlertTitle>
          <AlertDescription>Address: {user.address} | Balance: {user.balance} XLN</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <Card>
          <CardHeader>
            <CardTitle>Channels</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {channels.map((channel) => (
                <li
                  key={channel.id}
                  className={`p-2 rounded cursor-pointer ${
                    selectedChannel?.id === channel.id ? 'bg-blue-100' : 'bg-gray-100'
                  }`}
                  onClick={() => setSelectedChannel(channel)}
                >
                  <p className="font-semibold">Peer: {channel.peer}</p>
                  <p>Chain ID: {channel.chainId}, Token ID: {channel.tokenId}</p>
                  {renderCollateralLayout(channel)}
                </li>
              ))}
            </ul>
          </CardContent>
          <CardFooter>
            <Button onClick={handleCreateChannel} className="w-full">
              <PlusCircle className="mr-2 h-4 w-4" /> Create Channel
            </Button>
          </CardFooter>
        </Card>

        <Card className="col-span-2">
          <CardHeader>
            <CardTitle>Channel Details</CardTitle>
          </CardHeader>
          <CardContent>
            {selectedChannel ? (
              <Tabs defaultValue="view">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="view"><BarChart2 className="mr-2 h-4 w-4" /> View</TabsTrigger>
                  <TabsTrigger value="history"><Clock className="mr-2 h-4 w-4" /> History</TabsTrigger>
                  <TabsTrigger value="action"><PlayCircle className="mr-2 h-4 w-4" /> Action</TabsTrigger>
                </TabsList>
                <TabsContent value="view">
                  <div className="space-y-2">
                    <p><strong>Peer:</strong> {selectedChannel.peer}</p>
                    <p><strong>Chain ID:</strong> {selectedChannel.chainId}</p>
                    <p><strong>Token ID:</strong> {selectedChannel.tokenId}</p>
                    <p><strong>Collateral:</strong> {selectedChannel.derivedDelta.collateral.toString()}</p>
                    <p><strong>Delta:</strong> {selectedChannel.derivedDelta.delta.toString()}</p>
                    <p><strong>Own Credit Limit:</strong> {selectedChannel.derivedDelta.ownCreditLimit.toString()}</p>
                    <p><strong>Peer Credit Limit:</strong> {selectedChannel.derivedDelta.peerCreditLimit.toString()}</p>
                  </div>
                </TabsContent>
                <TabsContent value="history">
                  <ul className="space-y-2">
                    {history.map((item, index) => (
                      <li key={index} className="bg-gray-100 p-2 rounded">
                        <p><strong>{item.type}:</strong> {item.action || `Block ${item.number}`}</p>
                        <p><strong>Timestamp:</strong> {item.timestamp}</p>
                        {item.amount && <p><strong>Amount:</strong> {item.amount}</p>}
                        {item.transitions && <p><strong>Transitions:</strong> {item.transitions}</p>}
                      </li>
                    ))}
                  </ul>
                </TabsContent>
                <TabsContent value="action">
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="message">Send Message</Label>
                      <div className="flex mt-1">
                        <Input
                          id="message"
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          placeholder="Enter message"
                          className="flex-grow"
                        />
                        <Button onClick={handleSendMessage} className="ml-2">
                          <Send className="mr-2 h-4 w-4" /> Send
                        </Button>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="amount">Make Payment</Label>
                      <div className="flex mt-1">
                        <Input
                          id="amount"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          placeholder="Amount"
                          className="flex-grow"
                        />
                        <Input
                          value={recipient}
                          onChange={(e) => setRecipient(e.target.value)}
                          placeholder="Recipient address"
                          className="flex-grow ml-2"
                        />
                        <Button onClick={handlePayment} className="ml-2">
                          <Send className="mr-2 h-4 w-4" /> Pay
                        </Button>
                      </div>
                    </div>
                    <Button onClick={handleSwap} className="w-full">
                      <ArrowLeftRight className="mr-2 h-4 w-4" /> Initiate Swap
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>
            ) : (
              <p>Select a channel to view details and perform actions.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default XLNWebUI;
