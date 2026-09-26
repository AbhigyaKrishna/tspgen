"use client";

import { QueryClient } from "@tanstack/react-query";
import { createPetStoreClient } from "../generated/client";
import { petsCreateAction, petsRemoveAction } from "../generated/client/actions/pets";
import { usePetsCreateMutation, usePetsGetQuery, usePetsListQuery } from "../generated/client/react-query/hooks";
import { petStoreKeys, petStoreQueries } from "../generated/client/react-query/queries";

const client = createPetStoreClient({ baseUrl: "/api" });

export function PetName({ id }: { id: number }) {
  const pet = usePetsGetQuery({ petId: id }, { staleTime: 1000 });
  const list = usePetsListQuery({ species: "dog" });
  const create = usePetsCreateMutation({
    onSuccess: (result) => {
      if (result.status === 201) console.log(result.headers.location);
    },
  });
  return (
    <button onClick={() => create.mutate({ pet: { id, name: "Rex", species: "dog" } })}>
      {pet.data?.name} ({list.data?.length ?? 0})
    </button>
  );
}

export async function prefetch(queryClient: QueryClient): Promise<void> {
  await queryClient.prefetchQuery(petStoreQueries.pets.get(client, { petId: 1 }));
  await queryClient.invalidateQueries({ queryKey: petStoreKeys.pets.all });
}

export async function serverSide(): Promise<string> {
  const pets = await client.pets.list({ limit: 5 }, { next: { revalidate: 60, tags: ["pets"] } });
  const created = await petsCreateAction({ pet: { id: 2, name: "Tom", species: "cat" } });
  const removed = await petsRemoveAction({ petId: 2 });
  return `${pets.length} ${created.ok ? created.data.status : created.status} ${removed.ok}`;
}
