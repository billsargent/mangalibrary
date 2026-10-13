import { useAppReleases } from '@/colada/app-releases'
import { useActuatorInfo } from '@/colada/actuator-info'

/**
 * Composable that returns more detailed app releases information.
 */
export function useAppReleasesEnriched() {
  const { data, isLoading: isLoadingReleases, ...restReleases } = useAppReleases()
  const { buildVersion, isLoading: isLoadingActuator } = useActuatorInfo()

  const isLoading = computed(() => isLoadingReleases.value || isLoadingActuator.value)

  const latestRelease = computed(() => data.value?.find((x) => x.latest))

  const isLatestVersion = computed(() => {
    // No releases listed - no source of them is set - is not "an update is available".
    if (buildVersion.value && data.value && data.value.length > 0)
      return data.value?.some((x) => x.latest && x.version == buildVersion.value)
    else return undefined
  })

  return {
    releases: data,
    buildVersion,
    latestRelease,
    isLatestVersion,
    isLoading,
    ...restReleases,
  }
}
