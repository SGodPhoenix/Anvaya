import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import HomeScreen from '../screens/HomeScreen';
import FormScreen from '../screens/FormScreen';
import DispatchScreen from '../screens/DispatchScreen';
import DispatchItemWiseScreen from '../screens/DispatchItemWiseScreen';
import SaleOrderStatusScreen from '../screens/SaleOrderStatusScreen';
import PendingDispatchScreen from '../screens/PendingDispatchScreen';
import BoutiqueImagesScreen from '../screens/BoutiqueImagesScreen';
import BoutiqueFolderScreen from '../screens/BoutiqueFolderScreen';
import OutstandingScreen from '../screens/OutstandingScreen';
import NewSaleOrderScreen from '../screens/NewSaleOrderScreen';

export type RootStackParamList = {
  Home: undefined;
  Form: undefined;
  Dispatch: undefined;
  DispatchItemWise: undefined;
  SaleOrderStatus: undefined;
  PendingDispatch: undefined;
  BoutiqueImages: undefined;
  BoutiqueFolder: { folder: string };
  Outstanding: undefined;
  NewSaleOrder: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  return (
    <Stack.Navigator initialRouteName="Home" screenOptions={{ headerShown: true }}>
      <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Anvaya' }} />
      <Stack.Screen name="Form" component={FormScreen} options={{ title: 'Merge Invoices' }} />
      <Stack.Screen name="Dispatch" component={DispatchScreen} options={{ title: 'Dispatch' }} />
      <Stack.Screen name="DispatchItemWise" component={DispatchItemWiseScreen} options={{ title: 'Dispatch Item Wise' }} />
      <Stack.Screen name="SaleOrderStatus" component={SaleOrderStatusScreen} options={{ title: 'Sale Order Status (MTM)' }} />
      <Stack.Screen name="PendingDispatch" component={PendingDispatchScreen} options={{ title: 'Pending Dispatch' }} />
      <Stack.Screen name="BoutiqueImages" component={BoutiqueImagesScreen} options={{ title: 'Boutique Images' }} />
      <Stack.Screen name="BoutiqueFolder" component={BoutiqueFolderScreen} options={{ title: 'Boutique Folder' }} />
      <Stack.Screen name="Outstanding" component={OutstandingScreen} options={{ title: 'Outstanding' }} />
          <Stack.Screen name="NewSaleOrder" component={NewSaleOrderScreen} options={{ title: 'New Sale Order' }} />
    </Stack.Navigator>
  );
}
